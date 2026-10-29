"""Index local documents, extract selected content and materialize visual fallbacks."""

import argparse
import base64
import codecs
from collections import Counter
from copy import deepcopy
import hashlib
import importlib.metadata
import io
import json
import mimetypes
import os
from pathlib import Path
import posixpath
import re
import shutil
import sys
import tempfile
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile, is_zipfile


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
STOP_WORDS = set("the and for with from this that have will into about your they what when then than are not can use using 的 我们 一个 这个 这些 以及 可以 进行 通过 因为 所以 如果 就是 这里 然后 可能 需要 课程 内容".split())
SECTION_CHARACTERS = 8000
CACHE_MAX_BYTES = 512 * 1024 * 1024
CACHE_MAX_ENTRIES = 256
CACHE_MAX_AGE = 30 * 24 * 60 * 60


class ExtractionCache:
    def __init__(self, source, args):
        self.entry = None
        self.info = {"enabled": False, "hit": False}
        descriptor = source.parent / "document-cache.json"
        if not descriptor.is_file():
            return
        if args.pages or args.render_only:
            self.info["reason"] = "page_renders_are_task_local"
            return
        self.root = Path(json.loads(descriptor.read_text(encoding="utf-8"))["directory"])
        self.root.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        packages = sorted((distribution.metadata["Name"], distribution.version) for distribution in importlib.metadata.distributions())
        version = hashlib.sha256(Path(__file__).read_bytes() + json.dumps([sys.version, packages]).encode()).hexdigest()
        artifact = {"outline": args.outline, "textPages": args.text_pages, "sections": args.sections}
        self.info = {"enabled": True, "hit": False, "sourceHash": digest.hexdigest(), "readerVersion": version, "artifact": "outline" if args.outline else "text", "selection": args.text_pages or args.sections}
        key = hashlib.sha256(json.dumps([digest.hexdigest(), version, artifact], sort_keys=True).encode()).hexdigest()
        self.entry = self.root / key

    def restore(self, output):
        if self.entry is None:
            return None
        try:
            result = json.loads((self.entry / "result.json").read_text(encoding="utf-8"))
            os.utime(self.entry, None)
            for path in self.entry.iterdir():
                if path.name != "result.json":
                    shutil.copyfile(path, output / path.name)
        except FileNotFoundError:
            return None
        for field in ("content", "outline"):
            if result.get(field):
                result[field] = str(output / result[field])
        for image in result.get("images", []):
            image["path"] = str(output / image["path"])
        self.info["hit"] = True
        return result

    def publish(self, result):
        if self.entry is None or self.entry.exists():
            return
        if any("page" in image for image in result.get("images", [])):
            self.info.update({"stored": False, "reason": "page_renders_are_task_local"})
            return
        stored = deepcopy(result)
        files = []
        for field in ("content", "outline"):
            if stored.get(field):
                files.append(Path(stored[field]))
                stored[field] = Path(stored[field]).name
        for image in stored.get("images", []):
            files.append(Path(image["path"]))
            image["path"] = Path(image["path"]).name
        files = list(dict.fromkeys(files))
        if sum(path.stat().st_size for path in files) > CACHE_MAX_BYTES:
            self.info["stored"] = False
            return
        pending = Path(tempfile.mkdtemp(prefix=".pending-", dir=self.root))
        try:
            for path in files:
                shutil.copyfile(path, pending / path.name)
            (pending / "result.json").write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
            try:
                pending.rename(self.entry)
            except OSError:
                if not self.entry.is_dir():
                    raise
        finally:
            shutil.rmtree(pending, ignore_errors=True)

    def finish(self, result):
        if not self.info["hit"]:
            self.publish(result)
        if self.entry is not None:
            entries = []
            now = time.time()
            for path in self.root.iterdir():
                if not path.is_dir():
                    continue
                try:
                    modified = path.stat().st_mtime
                    if now - modified > (24 * 60 * 60 if path.name.startswith(".pending-") else CACHE_MAX_AGE):
                        shutil.rmtree(path, ignore_errors=True)
                    elif re.fullmatch(r"[a-f0-9]{64}", path.name):
                        entries.append((modified, path, sum(file.stat().st_size for file in path.iterdir() if file.is_file())))
                except FileNotFoundError:
                    continue
            total = sum(size for _, _, size in entries)
            count = len(entries)
            for _, path, size in sorted(entries):
                if total <= CACHE_MAX_BYTES and count <= CACHE_MAX_ENTRIES:
                    break
                shutil.rmtree(path, ignore_errors=True)
                total -= size
                count -= 1
        print(json.dumps({**result, "cache": self.info}, ensure_ascii=False))


def paragraph_text(paragraph):
    text = []
    for run in paragraph.iter(f"{W}r"):
        for node in run:
            if node.tag == f"{W}t":
                text.append(node.text or "")
            elif node.tag == f"{W}tab":
                text.append("\t")
            elif node.tag in (f"{W}br", f"{W}cr"):
                text.append("\n")
    return "".join(text)


def paragraph_slice(paragraph, start, end):
    paragraph = deepcopy(paragraph)
    position = 0
    for run in paragraph.iter(f"{W}r"):
        for node in list(run):
            if node.tag not in (f"{W}t", f"{W}tab", f"{W}br", f"{W}cr"):
                continue
            text = (node.text or "") if node.tag == f"{W}t" else "\t" if node.tag == f"{W}tab" else "\n"
            first = max(0, start - position)
            last = min(len(text), end - position)
            if node.tag == f"{W}t":
                node.text = text[first:last] if last > first else ""
                node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            elif last <= first:
                run.remove(node)
            position += len(text)
    return paragraph


def keyword_candidates(text):
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_+-]{1,23}|[\u4e00-\u9fff]{2,12}", text.casefold())
    return [word for word, _ in Counter(word for word in tokens if word not in STOP_WORDS).most_common(6)]


def document_kind(source):
    with source.open("rb") as stream:
        if stream.read(5) == b"%PDF-":
            return "pdf"
    if is_zipfile(source):
        with ZipFile(source) as archive:
            names = archive.namelist()
            if "ppt/presentation.xml" in names:
                return "pptx"
            if "word/document.xml" in names:
                return "docx"
        return "other"
    with source.open("rb") as stream:
        head = stream.read(4096)
    try:
        codecs.getincrementaldecoder("utf-8-sig")().decode(head, final=False)
        return "text" if b"\x00" not in head else "other"
    except UnicodeDecodeError:
        return "other"


def structured_units(source, kind):
    if kind == "pptx":
        with ZipFile(source) as archive:
            presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
            relationships = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
            targets = {rel.get("Id"): rel.get("Target") for rel in relationships}
            units = []
            for number, slide_id in enumerate(presentation.findall(f"{P}sldIdLst/{P}sldId"), 1):
                target = targets[slide_id.get(f"{R}id")]
                path = posixpath.normpath(posixpath.join("ppt", target)) if not target.startswith("/") else target.lstrip("/")
                slide = ET.fromstring(archive.read(path))
                lines = [node.text or "" for node in slide.iter(f"{A}t")]
                title = ""
                for shape in slide.iter(f"{P}sp"):
                    placeholder = shape.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
                    if placeholder is not None and placeholder.get("type") in ("title", "ctrTitle"):
                        title = " ".join(node.text or "" for node in shape.iter(f"{A}t"))
                        break
                rel_path = posixpath.join(posixpath.dirname(path), "_rels", posixpath.basename(path) + ".rels")
                if rel_path in archive.namelist():
                    for rel in ET.fromstring(archive.read(rel_path)):
                        if (rel.get("Type") or "").endswith("/notesSlide"):
                            target = rel.get("Target")
                            notes_path = posixpath.normpath(posixpath.join(posixpath.dirname(path), target)) if not target.startswith("/") else target.lstrip("/")
                            notes = ET.fromstring(archive.read(notes_path))
                            lines.extend(node.text or "" for node in notes.iter(f"{A}t"))
                units.append({"number": number, "text": "\n".join(lines), "title": title or next((line for line in lines if line.strip()), ""), "locator": {"slide": number}})
            return units
    if kind == "docx":
        with ZipFile(source) as archive:
            body = ET.fromstring(archive.read("word/document.xml")).find(f"{W}body")
            heading_styles = {f"Heading{i}" for i in range(1, 10)} | {f"标题{i}" for i in range(1, 10)}
            if "word/styles.xml" in archive.namelist():
                styles = list(ET.fromstring(archive.read("word/styles.xml")))
                for style in styles:
                    level = style.find(f"{W}pPr/{W}outlineLvl")
                    if level is not None:
                        if level.get(f"{W}val") in {str(i) for i in range(9)}:
                            heading_styles.add(style.get(f"{W}styleId"))
                        else:
                            heading_styles.discard(style.get(f"{W}styleId"))
                changed = True
                while changed:
                    changed = False
                    for style in styles:
                        identity = style.get(f"{W}styleId")
                        base = style.find(f"{W}basedOn")
                        if identity not in heading_styles and style.find(f"{W}pPr/{W}outlineLvl") is None and base is not None and base.get(f"{W}val") in heading_styles:
                            heading_styles.add(identity)
                            changed = True
            blocks = []
            for index, block in enumerate(body):
                if block.tag == f"{W}sectPr":
                    continue
                style = block.find(f"{W}pPr/{W}pStyle")
                heading = style is not None and style.get(f"{W}val") in heading_styles
                level = block.find(f"{W}pPr/{W}outlineLvl")
                if level is not None:
                    heading = level.get(f"{W}val") in {str(i) for i in range(9)}
                splittable = block.tag == f"{W}p" and not any(node.tag in {f"{W}drawing", f"{W}pict", f"{W}object", f"{W}fldChar", f"{W}fldSimple", f"{W}footnoteReference", f"{W}endnoteReference", f"{W}bookmarkStart", f"{W}commentRangeStart", "{http://schemas.openxmlformats.org/officeDocument/2006/math}oMath", "{http://schemas.openxmlformats.org/officeDocument/2006/math}oMathPara"} for node in block.iter())
                text = paragraph_text(block) if block.tag == f"{W}p" else "\n".join(node.text or "" for node in block.iter(f"{W}t"))
                blocks.append({"index": index + 1, "text": text, "heading": heading, "splittable": splittable})
    else:
        text = source.read_text(encoding="utf-8-sig")
        heading = re.compile(r"^\s*(?:#{1,6}\s+|第[零一二三四五六七八九十百\d]+[章节讲]|\d+(?:\.\d+)*[.)、]\s+|\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?\s*)")
        blocks = [{"index": index, "text": line, "heading": bool(heading.match(line)), "splittable": True} for index, line in enumerate(text.splitlines(), 1)]
    units = []
    pending = []
    size = 0
    for block in blocks:
        if len(block["text"]) > SECTION_CHARACTERS:
            if pending:
                units.append(pending)
                pending = []
                size = 0
            if block["splittable"]:
                for start in range(0, len(block["text"]), SECTION_CHARACTERS):
                    end = min(start + SECTION_CHARACTERS, len(block["text"]))
                    units.append([{**block, "text": block["text"][start:end], "charStart": start, "charEnd": end}])
            else:
                units.append([{**block, "oversized": True}])
            continue
        if pending and (block["heading"] or size + len(block["text"]) + 1 > SECTION_CHARACTERS):
            units.append(pending)
            pending = []
            size = 0
        size += len(block["text"]) + (1 if pending else 0)
        pending.append(block)
    if pending:
        units.append(pending)
    result = []
    for number, group in enumerate(units, 1):
        text = "\n".join(block["text"] for block in group)
        locator = {"blockStart" if kind == "docx" else "startLine": group[0]["index"], "blockEnd" if kind == "docx" else "endLine": group[-1]["index"]}
        if "charStart" in group[0]:
            locator.update({"charStart": group[0]["charStart"], "charEnd": group[0]["charEnd"]})
        timestamp = re.search(r"\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b", group[0]["text"])
        if timestamp:
            locator["timestamp"] = timestamp.group(0)
        unit = {"number": number, "text": text, "title": next((line.strip() for line in text.splitlines() if line.strip()), ""), "locator": locator}
        if group[0].get("oversized"):
            unit["warnings"] = [{"code": "oversized_structural_block", "block": group[0]["index"], "characters": len(text), "message": "This table or complex paragraph exceeds the section budget and is retained intact to preserve structure; read it selectively."}]
        result.append(unit)
    return result


def selected_office_stream(source, kind, units, selected):
    stream = io.BytesIO()
    with ZipFile(source) as archive, ZipFile(stream, "w") as filtered:
        path = "ppt/presentation.xml" if kind == "pptx" else "word/document.xml"
        tree = ET.fromstring(archive.read(path))
        if kind == "pptx":
            slides = tree.find(f"{P}sldIdLst")
            for number, child in enumerate(list(slides), 1):
                if number not in selected:
                    slides.remove(child)
        else:
            body = tree.find(f"{W}body")
            keep = {}
            for unit in units:
                if unit["number"] in selected:
                    locator = unit["locator"]
                    for number in range(locator["blockStart"], locator["blockEnd"] + 1):
                        if "charStart" not in locator:
                            keep[number] = None
                        elif number not in keep or keep[number] is not None:
                            keep.setdefault(number, []).append((locator["charStart"], locator["charEnd"]))
            for number, child in enumerate(list(body), 1):
                if number not in keep and child.tag != f"{W}sectPr":
                    body.remove(child)
                elif keep.get(number):
                    ranges = []
                    for start, end in sorted(keep[number]):
                        if ranges and start <= ranges[-1][1]:
                            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], end))
                        else:
                            ranges.append((start, end))
                    position = list(body).index(child)
                    for start, end in ranges:
                        body.insert(position, paragraph_slice(child, start, end))
                        position += 1
                    body.remove(child)
        for item in archive.infolist():
            filtered.writestr(item, ET.tostring(tree, encoding="utf-8", xml_declaration=True) if item.filename == path else archive.read(item))
    stream.seek(0)
    return stream


def write_outline(source, output, kind):
    warnings = [{"code": "outline_only", "message": "Local title/token-frequency candidates, not a semantic summary or confirmed teacher priorities. Body, images, formulas and tables have not been read."}]
    if kind == "pdf":
        import pypdfium2

        pdf = pypdfium2.PdfDocument(source)
        units = []
        try:
            for index in range(len(pdf)):
                page = pdf[index]
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_bounded()
                finally:
                    text_page.close()
                    page.close()
                units.append({"number": index + 1, "text": text, "title": next((line.strip() for line in text.splitlines() if line.strip()), ""), "locator": {"page": index + 1}})
        finally:
            pdf.close()
    elif kind in ("pptx", "docx", "text"):
        units = structured_units(source, kind)
    else:
        raise ValueError("--outline supports PDF, PPTX, DOCX and UTF-8 text transcripts")
    entries = [{"number": unit["number"], "titleCandidate": unit["title"][:100], "keywordCandidates": keyword_candidates(unit["text"]), "characters": len(unit["text"]), **unit["locator"]} for unit in units]
    warnings.extend(warning for unit in units for warning in unit.get("warnings", []))
    empty = [entry["number"] for entry in entries if not entry["characters"]]
    if empty:
        warnings.append({"code": "units_without_text", "units": empty, "message": "Inspect these pages/slides visually; they may contain images or be blank."})
    outline = output / "outline.json"
    header = {"kind": kind, "unitCount": len(entries), "method": "local_title_and_token_frequency", "keywordCandidates": keyword_candidates("\n".join(unit["text"] for unit in units)), "warnings": warnings}
    with outline.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(header, ensure_ascii=False)[:-1] + ',"units":[\n')
        stream.write(",\n".join(json.dumps(entry, ensure_ascii=False) for entry in entries))
        stream.write("\n]}\n")
    return {"status": "indexed", "outline": str(outline), **header}


def pdf_pages(value, count):
    pages = set()
    for part in value.split(","):
        bounds = part.strip().split("-")
        if len(bounds) == 1:
            first = last = int(bounds[0])
        elif len(bounds) == 2:
            first, last = map(int, bounds)
        else:
            raise ValueError("Use PDF page numbers or ranges, e.g. 1,3-6")
        if first < 1 or last < first or last > count:
            raise ValueError(f"Pages must be between 1 and {count}, in ascending ranges")
        pages.update(range(first, last + 1))
    return sorted(pages)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="Task-local artifact directory")
    parser.add_argument("--pages", help="PDF pages to render, e.g. 1,3 (one-based)")
    parser.add_argument("--text-pages", help="Extract only these PDF pages or PPTX slides, e.g. 1,3-6")
    parser.add_argument("--sections", help="Extract DOCX/text section numbers from --outline, e.g. 2-4")
    parser.add_argument("--outline", action="store_true", help="Write a compact local title/keyword index without converting full body or images")
    parser.add_argument("--render-only", action="store_true", help="Render --pages without extracting or overwriting text")
    args = parser.parse_args()
    if args.render_only and (not args.pages or args.text_pages):
        parser.error("--render-only requires --pages and cannot be combined with --text-pages")
    if args.outline and (args.pages or args.text_pages or args.sections or args.render_only):
        parser.error("--outline cannot be combined with body extraction or rendering options")
    source = args.input.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = ExtractionCache(source, args)
    cached = cache.restore(output)
    if cached is not None:
        cache.finish(cached)
        return
    kind = document_kind(source)
    if args.outline:
        cache.finish(write_outline(source, output, kind))
        return

    images = []
    warnings = []
    page_index = []
    text = ""
    has_text = False
    page_count = None
    is_pdf = kind == "pdf"
    if not is_pdf and (args.pages or args.render_only):
        raise ValueError("--pages and --render-only require a PDF document")
    if args.text_pages and kind not in ("pdf", "pptx"):
        raise ValueError("--text-pages requires a PDF or PPTX document")
    if args.sections and kind not in ("docx", "text"):
        raise ValueError("--sections requires a DOCX or UTF-8 text transcript")
    units = None
    if not args.render_only:
        from markitdown import MarkItDown

        converter = MarkItDown(enable_plugins=False)
        if not is_pdf:
            if args.text_pages or args.sections:
                units = structured_units(source, kind)
                selected = pdf_pages(args.text_pages or args.sections, len(units))
                warnings.extend(warning for unit in units if unit["number"] in selected for warning in unit.get("warnings", []))
                if kind in ("pptx", "docx"):
                    with selected_office_stream(source, kind, units, selected) as stream:
                        text = converter.convert_stream(stream, file_extension=f".{kind}", keep_data_uris=True).markdown
                    if kind == "pptx":
                        numbers = iter(selected)
                        text = re.sub(r"<!-- Slide number: \d+ -->", lambda _: f"<!-- Slide number: {next(numbers)} -->", text)
                else:
                    text = "\n\n".join(f"## 讲稿第 {unit['number']} 段（原文行 {unit['locator']['startLine']}-{unit['locator']['endLine']}）\n\n{unit['text']}" for unit in units if unit["number"] in selected)
            else:
                text = converter.convert_local(str(source), keep_data_uris=True).markdown
            has_text = bool(text.strip())

    if is_pdf:
        import pypdfium2

        pdf = pypdfium2.PdfDocument(source)
        try:
            page_count = len(pdf)
            selected = pdf_pages(args.text_pages, page_count) if args.text_pages else list(range(1, page_count + 1))
            rendered = pdf_pages(args.pages, page_count) if args.pages else []
            missing_text = []
            if not args.render_only:
                chunks = []
                line = 1
                for number in selected:
                    single = pypdfium2.PdfDocument.new()
                    try:
                        single.import_pages(pdf, pages=[number - 1])
                        with io.BytesIO() as stream:
                            single.save(stream)
                            stream.seek(0)
                            page_text = converter.convert_stream(stream, file_extension=".pdf", keep_data_uris=True).markdown.strip()
                    finally:
                        single.close()
                    if page_text:
                        has_text = True
                    else:
                        missing_text.append(number)
                    chunk = f"## PDF文件第 {number} 页\n\n{page_text}\n\n"
                    page_index.append({"page": number, "startLine": line, "endLine": line + chunk.count("\n") - 1, "characters": len(page_text)})
                    line += chunk.count("\n")
                    chunks.append(chunk)
                text = "".join(chunks)
                if missing_text:
                    warnings.append({"code": "pages_without_text", "pages": missing_text, "message": "These pages have no extracted text; inspect their page images before claiming coverage."})
                if not has_text and not rendered:
                    rendered = selected
            remaining = rendered[6:]
            for number in rendered[:6]:
                page = pdf[number - 1]
                bitmap = page.render(scale=2)
                try:
                    path = output / f"page-{number}.png"
                    bitmap.to_pil().save(path)
                    images.append({"path": str(path), "page": number})
                finally:
                    bitmap.close()
                    page.close()
            if remaining:
                warnings.append({"code": "remaining_pages", "pages": remaining})
        finally:
            pdf.close()

    def save_image(match):
        alt, mime, encoded = match.groups()
        extension = mimetypes.guess_extension(mime) or ".bin"
        data = base64.b64decode(encoded, validate=True)
        path = output / f"image-{hashlib.sha256(data).hexdigest()[:16]}{extension}"
        path.write_bytes(data)
        images.append({"path": str(path), "alt": alt})
        return f"![{alt}]({path.name})"

    text = re.sub(r"!\[([^\]]*)\]\(data:([^;]+);base64,([A-Za-z0-9+/=]+)\)", save_image, text)
    status = "rendered" if args.render_only else "extracted" if has_text else "needs_visual_read"
    if images:
        warnings.append({"code": "visual_content_unread", "message": "Images are available, but have not been interpreted."})
    if not args.render_only and not has_text:
        warnings.append({"code": "no_text", "message": "No text extracted; use page images when available."})
    body = None
    if not args.render_only:
        body = output / ("content-selected.md" if args.text_pages or args.sections else "content.md")
        body.write_text(text, encoding="utf-8")
    result = {"status": status, "content": str(body) if body else None, "characters": len(text), "images": images, "warnings": warnings}
    if is_pdf:
        result.update({"pageCount": page_count, "pageIndex": page_index})
    elif units is not None:
        result.update({"unitCount": len(units), "selectedUnits": [{"number": unit["number"], **unit["locator"]} for unit in units if unit["number"] in selected]})
    cache.finish(result)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
