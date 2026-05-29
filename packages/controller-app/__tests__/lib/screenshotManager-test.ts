/**
 * Tests for lib/screenshotManager.ts
 *
 * Because screenshotManager is a singleton, each test uses jest.resetModules()
 * + a fresh require() so state never leaks between cases.
 *
 * enable() / disable() / reset() return the internal queue promise, so tests
 * can await the returned value directly instead of relying on setImmediate.
 */

import type { screenshotManager as ScreenshotManagerType } from '../../lib/screenshotManager';

describe('ScreenshotManager', () => {
  let manager: typeof ScreenshotManagerType;
  let mockPrevent: jest.Mock;
  let mockAllow: jest.Mock;

  beforeEach(() => {
    jest.resetModules();

    mockPrevent = jest.fn().mockResolvedValue(undefined);
    mockAllow = jest.fn().mockResolvedValue(undefined);

    // Register fresh mock factory after resetting the module registry.
    jest.mock('expo-screen-capture', () => ({
      preventScreenCaptureAsync: mockPrevent,
      allowScreenCaptureAsync: mockAllow,
    }));

    ({ screenshotManager: manager } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../lib/screenshotManager') as {
        screenshotManager: typeof ScreenshotManagerType;
      });
  });

  // ── basic enable / disable ────────────────────────────────────────────────

  it('single enable() calls preventScreenCaptureAsync once', async () => {
    await manager.enable();

    expect(mockPrevent).toHaveBeenCalledTimes(1);
    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('multiple enable() calls only invoke preventScreenCaptureAsync once', async () => {
    await manager.enable();
    await manager.enable();
    await manager.enable();

    expect(mockPrevent).toHaveBeenCalledTimes(1);
    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('enable() × 2 then disable() × 1 does not call allowScreenCaptureAsync', async () => {
    await manager.enable();
    await manager.enable();

    await manager.disable();

    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('enable() × 2 then disable() × 2 calls allowScreenCaptureAsync once', async () => {
    await manager.enable();
    await manager.enable();

    await manager.disable();
    await manager.disable();

    expect(mockPrevent).toHaveBeenCalledTimes(1);
    expect(mockAllow).toHaveBeenCalledTimes(1);
  });

  it('disable() when count is already 0 does not call any API', async () => {
    await manager.disable();

    expect(mockPrevent).not.toHaveBeenCalled();
    expect(mockAllow).not.toHaveBeenCalled();
  });

  // ── failure resilience ────────────────────────────────────────────────────

  it('preventScreenCaptureAsync failure leaves enabled=false so next enable() retries', async () => {
    mockPrevent.mockRejectedValueOnce(new Error('permission denied'));

    await manager.enable();

    expect(mockPrevent).toHaveBeenCalledTimes(1);

    // enabled is still false internally — a subsequent enable() must retry.
    await manager.enable();

    expect(mockPrevent).toHaveBeenCalledTimes(2);
  });

  it('allowScreenCaptureAsync failure leaves enabled=true so next disable() retries', async () => {
    await manager.enable();

    mockAllow.mockRejectedValueOnce(new Error('system error'));

    await manager.disable();

    expect(mockAllow).toHaveBeenCalledTimes(1);

    // enabled is still true internally — a subsequent disable() must retry.
    await manager.disable();

    expect(mockAllow).toHaveBeenCalledTimes(2);
  });

  // ── queue serialisation ───────────────────────────────────────────────────

  it('rapid enable/disable/enable settles with prevention active', async () => {
    // All three must be enqueued synchronously so the queue coalesces them.
    // By the time all updates run, count=1 and the intermediate disable
    // transition is a no-op (enabled stays true after the first enable).
    manager.enable();
    manager.disable();
    await manager.enable();

    expect(mockPrevent).toHaveBeenCalledTimes(1);
    expect(mockAllow).not.toHaveBeenCalled();
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  it('reset() while enabled forces allowScreenCaptureAsync and clears count', async () => {
    await manager.enable();
    await manager.enable(); // count=2, enabled=true

    await manager.reset(); // count=0 → should disable

    expect(mockAllow).toHaveBeenCalledTimes(1);

    // Further disable() should be a no-op (count already 0, enabled already false).
    await manager.disable();

    expect(mockAllow).toHaveBeenCalledTimes(1);
  });

  it('reset() when already disabled is a no-op', async () => {
    await manager.reset();

    expect(mockPrevent).not.toHaveBeenCalled();
    expect(mockAllow).not.toHaveBeenCalled();
  });
});
