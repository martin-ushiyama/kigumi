/**
 * NBT writer for Bedrock.
 * Bedrock's file format is "little-endian, uncompressed" (distinct from the
 * Java edition's big-endian + gzip). Only the tag types needed for
 * .mcstructure are implemented.
 */

export type NbtValue =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'list'; value: NbtValue[] }
  /** Memory-efficient version of TAG_List<TAG_Int>, for large block_indices (avoids allocating an object per element) */
  | { type: 'intList'; value: Int32Array | number[] }
  | { type: 'compound'; value: Record<string, NbtValue> };

const TAG_ID: Record<NbtValue['type'], number> = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  string: 8,
  list: 9,
  intList: 9, // Identical to TAG_List<TAG_Int> for serialization purposes
  compound: 10,
};

export const nbt = {
  byte: (value: number): NbtValue => ({ type: 'byte', value }),
  short: (value: number): NbtValue => ({ type: 'short', value }),
  int: (value: number): NbtValue => ({ type: 'int', value }),
  long: (value: bigint): NbtValue => ({ type: 'long', value }),
  float: (value: number): NbtValue => ({ type: 'float', value }),
  double: (value: number): NbtValue => ({ type: 'double', value }),
  string: (value: string): NbtValue => ({ type: 'string', value }),
  list: (value: NbtValue[]): NbtValue => ({ type: 'list', value }),
  intList: (value: Int32Array | number[]): NbtValue => ({ type: 'intList', value }),
  compound: (value: Record<string, NbtValue>): NbtValue => ({ type: 'compound', value }),
};

class ByteWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.len, v);
    this.len += 1;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
  }
  i64(v: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.len, v, true);
    this.len += 8;
  }
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
  }
  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const encoder = new TextEncoder();

function writeString(w: ByteWriter, s: string): void {
  const bytes = encoder.encode(s);
  w.u16(bytes.length);
  w.bytes(bytes);
}

function writePayload(w: ByteWriter, tag: NbtValue): void {
  switch (tag.type) {
    case 'byte':
      w.u8(tag.value & 0xff);
      break;
    case 'short':
      w.i16(tag.value);
      break;
    case 'int':
      w.i32(tag.value);
      break;
    case 'long':
      w.i64(tag.value);
      break;
    case 'float':
      w.f32(tag.value);
      break;
    case 'double':
      w.f64(tag.value);
      break;
    case 'string':
      writeString(w, tag.value);
      break;
    case 'intList': {
      w.u8(TAG_ID.int);
      w.i32(tag.value.length);
      for (let i = 0; i < tag.value.length; i++) w.i32(tag.value[i]!);
      break;
    }
    case 'list': {
      const itemType = tag.value.length ? TAG_ID[tag.value[0]!.type] : 0;
      for (const item of tag.value) {
        if (TAG_ID[item.type] !== itemType) {
          throw new Error('NBT list has mixed element types');
        }
      }
      w.u8(itemType);
      w.i32(tag.value.length);
      for (const item of tag.value) writePayload(w, item);
      break;
    }
    case 'compound': {
      for (const [name, child] of Object.entries(tag.value)) {
        w.u8(TAG_ID[child.type]);
        writeString(w, name);
        writePayload(w, child);
      }
      w.u8(0); // TAG_End
      break;
    }
  }
}

/** Serialize the root compound into Bedrock's NBT file format (LE, uncompressed) */
export function writeNbt(root: NbtValue & { type: 'compound' }, rootName = ''): Uint8Array {
  const w = new ByteWriter();
  w.u8(TAG_ID.compound);
  writeString(w, rootName);
  writePayload(w, root);
  return w.result();
}
