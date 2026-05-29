import { usePreventScreenshot } from '@/hooks/usePreventScreenshot';

type Props = {
  enabled?: boolean;
  children: React.ReactNode;
};

export function PreventScreenshot({ enabled = true, children }: Props) {
  usePreventScreenshot(enabled);

  return <>{children}</>;
}
