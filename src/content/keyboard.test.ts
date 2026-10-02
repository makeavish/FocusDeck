import { afterEach, describe, expect, it, vi } from "vitest";
import { installKeyboardShortcuts } from "./keyboard";

class Control {
  tagName = "INPUT";
  isContentEditable = false;
}
afterEach(() => vi.unstubAllGlobals());

describe("keyboard shortcut interception", () => {
  it.each([false, true])("intercepts scrolling keys only while a managed session is active: %s", (active) => {
    let listener!: (event: KeyboardEvent) => void;
    vi.stubGlobal("HTMLElement", Control);
    vi.stubGlobal("window", { addEventListener: (_name: string, callback: typeof listener) => { listener = callback; }, removeEventListener: vi.fn() });
    const onNext = vi.fn();
    const preventDefault = vi.fn();
    const cleanup = installKeyboardShortcuts({ isActive: () => active, onNext, onPrevious: vi.fn(), onBookmark: vi.fn(), onNotInterested: vi.fn(), onOpenPost: vi.fn() });
    listener({ key: "ArrowDown", composedPath: () => [], preventDefault } as unknown as KeyboardEvent);
    expect(onNext).toHaveBeenCalledTimes(active ? 1 : 0);
    expect(preventDefault).toHaveBeenCalledTimes(active ? 1 : 0);
    cleanup();
  });

  it("uses the composed origin to leave shadow-root inputs editable", () => {
    let listener!: (event: KeyboardEvent) => void;
    vi.stubGlobal("HTMLElement", Control);
    vi.stubGlobal("window", { addEventListener: (_name: string, callback: typeof listener) => { listener = callback; }, removeEventListener: vi.fn() });
    const onNext = vi.fn();
    const preventDefault = vi.fn();
    const cleanup = installKeyboardShortcuts({ onNext, onPrevious: vi.fn(), onBookmark: vi.fn(), onNotInterested: vi.fn(), onOpenPost: vi.fn() });
    listener({ key: "ArrowDown", target: {}, composedPath: () => [new Control()], preventDefault } as unknown as KeyboardEvent);
    expect(onNext).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    cleanup();
  });
});
