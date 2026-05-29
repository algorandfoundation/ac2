import * as ScreenCapture from 'expo-screen-capture';

class ScreenshotManager {
  private count = 0;
  private enabled = false;
  private queue: Promise<void> = Promise.resolve();

  private async update() {
    const shouldEnable = this.count > 0;

    if (shouldEnable === this.enabled) return;

    const currentCount = this.count; // Capture the current count for logging

    if (shouldEnable) {
      await ScreenCapture.preventScreenCaptureAsync();
      this.enabled = true;
      console.debug('Screenshot prevention enabled. Count:', currentCount);
    } else {
      await ScreenCapture.allowScreenCaptureAsync();
      this.enabled = false;
      console.debug('Screenshot prevention disabled. Count:', currentCount);
    }
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue
      .then(() => this.update())
      .catch((error) => {
        // Swallow the error so that subsequent operations are not blocked.
        console.error('Failed to update screenshot capture state: ', error);
      });
    return this.queue;
  }

  enable(): Promise<void> {
    this.count++;
    return this.enqueue();
  }

  disable(): Promise<void> {
    this.count = Math.max(0, this.count - 1);
    return this.enqueue();
  }

  reset(): Promise<void> {
    this.count = 0;
    return this.enqueue();
  }
}

export const screenshotManager = new ScreenshotManager();
