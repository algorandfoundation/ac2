import { screenshotManager } from '@/lib/screenshotManager';
import React, { useEffect } from 'react';

// Not really a provider, but this is where we can do the safety reset on unmount
export function PreventScreenshotProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    return () => {
      // Safety reset when app unmounts
      screenshotManager.reset().catch((error) => {
        console.error('Failed to reset screenshot manager on unmount: ', error);
      });
    };
  }, []);

  return <>{children}</>;
}
