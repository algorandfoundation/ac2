import { screenshotManager } from '@/lib/screenshotManager';
import { useEffect } from 'react';

export function usePreventScreenshot(enabled = true) {
  useEffect(() => {
    if (__DEV__) {
      console.log('Screenshot prevention disabled for development builds.');
      return;
    }
    if (!enabled) return;

    void screenshotManager.enable().catch((error) => {
      console.error('Failed to enable screenshot prevention: ', error);
    });

    return () => {
      void screenshotManager.disable().catch((error) => {
        console.error('Failed to disable screenshot prevention: ', error);
      });
    };
  }, [enabled]);
}
