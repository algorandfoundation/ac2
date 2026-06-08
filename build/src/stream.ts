import { Transform } from "node:stream";

export class VoidStream extends Transform {
  constructor(_options?: any) {
    super();
  }

  _transform(_chunk: any, _encoding: string, callback: () => void) {
    callback();
  }
}

export class RescopedStream extends Transform {
  private readonly scope: string;

  constructor(stream: NodeJS.WritableStream, scope: string) {
    super();
    this.scope = scope;
    this.pipe(stream);
  }

  _transform(chunk: any, _encoding: string, callback: (error?: Error | null, data?: any) => void) {
    this.push(`[${this.scope}]: ${chunk.toString()}`);
    callback();
  }
}
