import { useEffect, useRef, useState } from "react";
import type { T } from "../i18n";

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: "color-mix(in oklab, #000 45%, transparent)" }}
      role="presentation"
    >
      {children}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="w-full max-w-[380px] rounded-xl border p-4 shadow-2xl"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-raised)",
        color: "var(--fg)",
      }}
    >
      <div className="mb-2 text-[13px] font-medium">{title}</div>
      {children}
    </div>
  );
}

function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const style =
    variant === "primary"
      ? { background: "var(--accent)", color: "var(--bg)", borderColor: "transparent" }
      : variant === "danger"
        ? { color: "var(--danger)", borderColor: "var(--border-strong)" }
        : { color: "var(--secondary)", borderColor: "var(--border-strong)" };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border px-3 py-1.5 text-[12px] transition-colors hover:opacity-85 disabled:cursor-default disabled:opacity-40"
      style={style}
    >
      {children}
    </button>
  );
}

export function PromptDialog({
  title,
  hint,
  label,
  initialValue = "",
  confirmLabel,
  t,
  onCancel,
  onSubmit,
}: {
  title: string;
  hint?: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  t: T;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // 重命名时选中主文件名，扩展名留给用户按需修改。
    const dot = initialValue.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initialValue]);

  const submit = () => {
    const next = value.trim();
    if (next) onSubmit(next);
  };

  return (
    <Overlay>
      <Card title={title}>
        {hint ? (
          <div className="mb-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
            {hint}
          </div>
        ) : null}
        <label className="mb-3 block">
          <span className="mb-1 block text-[11px]" style={{ color: "var(--muted)" }}>
            {label}
          </span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            className="w-full rounded-md border px-2 py-1.5 text-[12px] outline-none"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg)",
              color: "var(--fg)",
            }}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>{t("cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </Overlay>
  );
}

export function ConfirmDialog({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: Array<{ label: string; variant?: "primary" | "ghost" | "danger"; onPick: () => void }>;
}) {
  return (
    <Overlay>
      <Card title={title}>
        <div className="mb-3 text-[12px] leading-relaxed" style={{ color: "var(--secondary)" }}>
          {body}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {actions.map((action) => (
            <Button key={action.label} variant={action.variant} onClick={action.onPick}>
              {action.label}
            </Button>
          ))}
        </div>
      </Card>
    </Overlay>
  );
}
