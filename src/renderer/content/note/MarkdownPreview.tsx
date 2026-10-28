import { useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react';
import { defaultRehypePlugins } from 'streamdown';
import { decodeAssetPath, isRelativeAssetPath, noteAssetUrl } from '../../../shared/note-files';
import { ChatMarkdown } from '../chat/markdown';

type MarkdownNode = {
  type: string;
  tagName?: string;
  properties?: { src?: unknown };
  children?: MarkdownNode[];
};

export function MarkdownPreview({
  entryId,
  value,
  scroll,
  onScroll,
  plugins,
  controls,
}: {
  entryId: string;
  value: string;
  scroll: number;
  onScroll: (top: number) => void;
  plugins?: ComponentProps<typeof ChatMarkdown>['plugins'];
  controls?: ComponentProps<typeof ChatMarkdown>['controls'];
}) {
  const host = useRef<HTMLDivElement>(null);
  const rehypePlugins = useMemo(() => {
    const resolveImages = () => {
      const visit = (node: MarkdownNode) => {
        const src = node.properties?.src;
        if (node.tagName === 'img' && typeof src === 'string' && isRelativeAssetPath(src))
          node.properties!.src = noteAssetUrl(entryId, decodeAssetPath(src));
        node.children?.forEach(visit);
      };
      return visit;
    };
    return [
      defaultRehypePlugins.raw!,
      defaultRehypePlugins.sanitize!,
      resolveImages,
      defaultRehypePlugins.harden!,
    ];
  }, [entryId]);
  useLayoutEffect(() => {
    if (host.current) host.current.scrollTop = scroll;
  }, []);

  return (
    <div
      ref={host}
      role="region"
      aria-label="Markdown 阅读预览"
      tabIndex={0}
      className="min-h-0 min-w-0 flex-1 overflow-auto p-6"
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <ChatMarkdown
        className="mx-auto max-w-[60rem] break-words text-sm leading-7 text-ink [&_h1]:mt-0 [&_h1]:mb-6 [&_h1]:text-2xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h3]:mt-6 [&_h3]:text-lg [&_img]:max-w-full [&_table]:text-sm"
        rehypePlugins={rehypePlugins}
        plugins={plugins}
        controls={controls}
      >
        {value}
      </ChatMarkdown>
    </div>
  );
}
