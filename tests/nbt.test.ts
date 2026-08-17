import { describe, expect, it } from 'vitest';
import { nbt, writeNbt } from '../src/export/nbt';
import { readNbt } from './nbt-reader';

describe('NBT writer (Bedrock LE)', () => {
  it('writes the byte sequence of a minimal compound exactly as specified', () => {
    // { "" : { test: int 5 } }
    const bytes = writeNbt(nbt.compound({ test: nbt.int(5) }) as never);
    expect([...bytes]).toEqual([
      10, // TAG_Compound
      0, 0, // root name "" (length 0, LE uint16)
      3, // TAG_Int
      4, 0, // name length 4
      0x74, 0x65, 0x73, 0x74, // "test"
      5, 0, 0, 0, // int 5 (LE)
      0, // TAG_End
    ]);
  });

  it('writes a string as uint16 length + UTF-8', () => {
    const bytes = writeNbt(nbt.compound({ s: nbt.string('abc') }) as never);
    expect([...bytes]).toEqual([
      10, 0, 0,
      8, // TAG_String
      1, 0, 0x73, // "s"
      3, 0, 0x61, 0x62, 0x63, // "abc"
      0,
    ]);
  });

  it('writes a list as element type + int32 count + payload sequence', () => {
    const bytes = writeNbt(nbt.compound({ l: nbt.list([nbt.int(1), nbt.int(-1)]) }) as never);
    expect([...bytes]).toEqual([
      10, 0, 0,
      9, // TAG_List
      1, 0, 0x6c, // "l"
      3, // element type int
      2, 0, 0, 0, // count 2
      1, 0, 0, 0,
      0xff, 0xff, 0xff, 0xff, // -1
      0,
    ]);
  });

  it('writes an empty list with element type 0 (TAG_End)', () => {
    const bytes = writeNbt(nbt.compound({ e: nbt.list([]) }) as never);
    expect([...bytes]).toEqual([10, 0, 0, 9, 1, 0, 0x65, 0, 0, 0, 0, 0, 0]);
  });

  it('round-trips through the reader (nested compound / every type)', () => {
    const root = nbt.compound({
      b: nbt.byte(200),
      i: nbt.int(-12345),
      s: nbt.string('日本語もOK'),
      nested: nbt.compound({ f: nbt.float(1.5), lst: nbt.list([nbt.string('a'), nbt.string('b')]) }),
    });
    const parsed = readNbt(writeNbt(root as never));
    expect(parsed.name).toBe('');
    const v = parsed.value as Record<string, unknown>;
    expect(v.b).toBe(200);
    expect(v.i).toBe(-12345);
    expect(v.s).toBe('日本語もOK');
    expect((v.nested as Record<string, unknown>).f).toBe(1.5);
    expect((v.nested as Record<string, unknown>).lst).toEqual(['a', 'b']);
  });

  it('errors on a list with mixed types', () => {
    expect(() => writeNbt(nbt.compound({ bad: nbt.list([nbt.int(1), nbt.string('x')]) }) as never)).toThrow();
  });
});
