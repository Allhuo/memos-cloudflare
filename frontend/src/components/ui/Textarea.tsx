import * as React from "react";
import clsx from "clsx";

// @usememos/mui 自 canary.2026xx 起移除了 Textarea 组件，
// 此为本地兼容实现，复用 theme.css 中的 .mui-input 样式以保持外观一致。
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  fullWidth?: boolean;
  size?: "xs" | "sm" | "md" | "lg";
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, disabled, fullWidth, size = "md", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={clsx("mui-input", fullWidth && "w-full", className)}
        data-disabled={disabled ? "" : undefined}
        data-size={size}
        disabled={disabled}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
export type { TextareaProps };
