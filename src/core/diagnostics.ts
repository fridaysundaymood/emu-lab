import type { Readable } from 'node:stream';

const withheld =
  '[emulator output withheld: console token unavailable for redaction]';

export function collectDiagnostics(
  streams: Readable[],
  token: string,
): () => string {
  let output = '';
  for (const stream of streams) {
    let pending = '';
    let overflow = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      for (const character of chunk) {
        if (character === '\n') {
          if (!overflow && token) {
            const line = pending
              .split(token)
              .join('[redacted]')
              .replace(
                /(auth(?:entication)?\s+token\s*[:=]\s*)\S+/gi,
                '$1[redacted]',
              );
            output = `${output}${line}\n`.slice(-16_384);
          }
          pending = '';
          overflow = false;
        } else if (!overflow) {
          pending += character;
          if (pending.length > 16_384) {
            pending = '';
            overflow = true;
          }
        }
      }
    });
    (stream as Readable & { unref?: () => void }).unref?.();
  }
  return () => (token ? output : withheld);
}
