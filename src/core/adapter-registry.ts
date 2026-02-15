import type { Adapter } from "@/types/adapter";

export class AdapterRegistry {
  private readonly adapters: Adapter[] = [];

  register(adapter: Adapter): void {
    const existingIndex = this.adapters.findIndex((item) => item.id === adapter.id);

    if (existingIndex >= 0) {
      this.adapters.splice(existingIndex, 1, adapter);
      return;
    }

    this.adapters.push(adapter);
  }

  resolve(url: string): Adapter | null {
    return this.adapters.find((adapter) => adapter.isSupportedUrl(url)) ?? null;
  }

  list(): Adapter[] {
    return [...this.adapters];
  }
}
