import { useState } from 'react';
import { Check, Eye } from 'lucide-react';
import type { LearningPracticeCard, PracticeAttemptInput } from '../../../shared/learning';
import { Button } from '../../components/ui/button';
import { errorText } from '../../workspace/store';
import { cn } from '../../lib/utils';

const fieldClass =
  'w-full rounded-control bg-field px-3 py-2 text-13 text-ink shadow-hairline outline-none transition-shadow placeholder:text-ink-3 focus-visible:shadow-[0_0_0_2px_var(--bui-accent)]';

export function PracticeReview({
  card,
  onSubmit,
}: {
  card: LearningPracticeCard;
  onSubmit: (input: PracticeAttemptInput) => Promise<void>;
}) {
  return (
    <PracticeAttempt
      card={card}
      key={`${card.id}:${card.updatedAt}:${card.prompt}:${card.answer}`}
      onSubmit={onSubmit}
    />
  );
}

function PracticeAttempt({
  card,
  onSubmit,
}: {
  card: LearningPracticeCard;
  onSubmit: (input: PracticeAttemptInput) => Promise<void>;
}) {
  const [response, setResponse] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [outcome, setOutcome] = useState<PracticeAttemptInput['outcome'] | null>(null);
  const [errorCause, setErrorCause] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <article className="rounded-card border border-line bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>到期练习 · 已记录 {card.attempts.length} 次作答</span>
        <span>{card.sourceIds.length} 份参考资料</span>
      </div>
      <h3 className="whitespace-pre-wrap text-15 font-medium leading-relaxed">{card.prompt}</h3>
      <label className="mt-4 block text-xs font-medium text-ink-2" htmlFor={`response-${card.id}`}>
        你的作答或思路
      </label>
      <textarea
        className={cn(fieldClass, 'mt-2 min-h-28 resize-y disabled:opacity-70')}
        disabled={revealed || saving}
        id={`response-${card.id}`}
        maxLength={10000}
        onChange={(event) => setResponse(event.target.value)}
        placeholder="先独立回忆，再写下答案；想不起来也可以如实记录。"
        value={response}
      />
      {!revealed ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-3">写下自己的思路后，再对照参考答案。</p>
          <Button disabled={!response.trim()} onClick={() => setRevealed(true)} variant="outline">
            <Eye className="size-4" />
            查看参考答案
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="rounded-control bg-inset p-4">
            <p className="mb-2 text-xs font-medium text-ink-3">参考答案</p>
            <p className="whitespace-pre-wrap text-13 leading-relaxed">{card.answer}</p>
          </div>
          <fieldset disabled={saving}>
            <legend className="mb-2 text-xs font-medium text-ink-2">这次完成得怎样？</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['again', '还需再练'],
                  ['hard', '有些困难'],
                  ['good', '独立完成'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  aria-pressed={outcome === value}
                  key={value}
                  onClick={() => setOutcome(value)}
                  size="sm"
                  variant={outcome === value ? 'secondary' : 'outline'}
                >
                  {outcome === value && <Check className="size-3.5" />}
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <label className="block text-xs font-medium text-ink-2" htmlFor={`cause-${card.id}`}>
            {outcome === 'good' ? '复盘与收获（选填）' : '哪里卡住了？记录错因或遗漏'}
            <textarea
              className={cn(fieldClass, 'mt-2 min-h-16 resize-y font-normal')}
              disabled={saving}
              id={`cause-${card.id}`}
              maxLength={2000}
              onChange={(event) => setErrorCause(event.target.value)}
              placeholder="例如：混淆了适用条件，下一次先判断独立性。"
              value={errorCause}
            />
          </label>
          {error && (
            <p className="text-13 text-red" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-3">保存真实作答，并安排下一次复习。</p>
            <Button
              disabled={saving || !outcome || (outcome !== 'good' && !errorCause.trim())}
              onClick={() => {
                if (!outcome) return;
                setSaving(true);
                setError(null);
                void onSubmit({
                  cardId: card.id,
                  expectedUpdatedAt: card.updatedAt,
                  response: response.trim(),
                  outcome,
                  errorCause: errorCause.trim(),
                })
                  .catch((reason: unknown) => setError(errorText(reason)))
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? '正在保存…' : '记录作答'}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
