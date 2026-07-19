import {
  Button as MuiButton,
  Checkbox as MuiCheckbox,
  Input as MuiInput,
  Switch as MuiSwitch,
  type ButtonVariant as MuiButtonVariant,
} from "@usememos/mui";
import clsx from "clsx";
import * as React from "react";

// @usememos/mui 在 canary.2026xx 版本重构了组件 API（旧版已从 npm 下架）。
// 此兼容层将项目沿用的旧 API 适配到新组件，业务代码无需改动：
// - Button: variant plain/outlined + color → 新 variant 体系
// - Input: fullWidth prop → w-full class
// - Checkbox/Switch: onChange(e.target.checked) → onCheckedChange(checked)
// - Textarea: 新版已移除，见 ./Textarea

export { Textarea } from "./Textarea";

type ControlSize = "xs" | "sm" | "md" | "lg";

// ---------- Button ----------

interface ButtonProps extends Omit<React.ComponentProps<typeof MuiButton>, "variant" | "color"> {
  variant?: "plain" | "outlined" | MuiButtonVariant;
  color?: "primary" | "danger" | string;
  fullWidth?: boolean;
}

const BUTTON_VARIANT_MAP: Record<string, MuiButtonVariant> = {
  plain: "ghost",
  outlined: "outline",
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ variant, color, fullWidth, className, ...props }, ref) => {
  let mappedVariant: MuiButtonVariant;
  if (variant) {
    mappedVariant = BUTTON_VARIANT_MAP[variant] ?? (variant as MuiButtonVariant);
  } else if (color === "danger") {
    mappedVariant = "destructive";
  } else {
    mappedVariant = "default";
  }
  return <MuiButton ref={ref} variant={mappedVariant} className={clsx(fullWidth && "w-full", className)} {...props} />;
});
Button.displayName = "Button";

// ---------- Input ----------

interface InputProps extends React.ComponentProps<typeof MuiInput> {
  fullWidth?: boolean;
  startDecorator?: React.ReactNode;
  endDecorator?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ fullWidth, startDecorator, endDecorator, className, ...props }, ref) => {
  if (startDecorator || endDecorator) {
    // 旧版 Input 支持首尾装饰器；新版移除后以外层容器模拟同等布局
    const { size: _size, ...nativeProps } = props;
    return (
      <div className={clsx("mui-input flex flex-row items-center gap-1", fullWidth && "w-full", className)}>
        {startDecorator}
        <input ref={ref} className="grow min-w-0 bg-transparent border-none outline-none p-0" {...(nativeProps as React.InputHTMLAttributes<HTMLInputElement>)} />
        {endDecorator}
      </div>
    );
  }
  return <MuiInput ref={ref} className={clsx(fullWidth && "w-full", className)} {...props} />;
});
Input.displayName = "Input";

// ---------- 旧版 onChange 事件适配 ----------

interface LegacyCheckedChangeEvent {
  target: { checked: boolean };
}

// ---------- Checkbox ----------

interface CheckboxProps extends Omit<React.ComponentProps<typeof MuiCheckbox>, "onChange" | "size"> {
  label?: React.ReactNode;
  size?: ControlSize;
  onChange?: (event: LegacyCheckedChangeEvent) => void;
}

const Checkbox = ({ label, onChange, onCheckedChange, ...props }: CheckboxProps) => {
  const handleCheckedChange: NonNullable<React.ComponentProps<typeof MuiCheckbox>["onCheckedChange"]> = (checked, eventDetails) => {
    onCheckedChange?.(checked, eventDetails);
    onChange?.({ target: { checked } });
  };
  return (
    <MuiCheckbox onCheckedChange={handleCheckedChange} {...props}>
      {label != null && <span className="ml-1 select-none">{label}</span>}
    </MuiCheckbox>
  );
};

// ---------- Switch ----------

interface SwitchProps extends Omit<React.ComponentProps<typeof MuiSwitch>, "onChange" | "size"> {
  size?: ControlSize;
  onChange?: (event: LegacyCheckedChangeEvent) => void;
}

const Switch = ({ onChange, onCheckedChange, ...props }: SwitchProps) => {
  const handleCheckedChange: NonNullable<React.ComponentProps<typeof MuiSwitch>["onCheckedChange"]> = (checked, eventDetails) => {
    onCheckedChange?.(checked, eventDetails);
    onChange?.({ target: { checked } });
  };
  return <MuiSwitch onCheckedChange={handleCheckedChange} {...props} />;
};

export { Button, Checkbox, Input, Switch };
export type { ButtonProps, CheckboxProps, InputProps, SwitchProps };
