export class SseEventDecoder {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];

    while (true) {
      const delimiterIndex = this.buffer.indexOf('\n\n');
      if (delimiterIndex === -1) {
        break;
      }

      const rawEvent = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + 2);

      const dataLines = rawEvent
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length > 0) {
        events.push(dataLines.join('\n'));
      }
    }

    return events;
  }

  flush(): string[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    const pending = this.buffer;
    this.buffer = '';
    const dataLines = pending
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    return dataLines.length > 0 ? [dataLines.join('\n')] : [];
  }
}
