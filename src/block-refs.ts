export class BlockRefIssuer {
  private next = 1;

  issue(): string {
    return `b${this.next++}`;
  }

  rebuildFrom(existingBlockIds: string[]): void {
    if (existingBlockIds.length === 0) {
      this.next = 1;
      return;
    }
    const max = Math.max(...existingBlockIds.map((id) => parseInt(id.slice(1), 10)));
    this.next = max + 1;
  }
}
