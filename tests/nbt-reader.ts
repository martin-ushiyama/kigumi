/** Minimal test-only NBT reader (little-endian, uncompressed). For independent verification of the writer */

export type ParsedNbt =
  | number
  | bigint
  | string
  | ParsedNbt[]
  | { [key: string]: ParsedNbt };

export function readNbt(bytes: Uint8Array): { name: string; value: ParsedNbt } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let pos = 0;

  const u8 = () => view.getUint8(pos++);
  const i16 = () => {
    const v = view.getInt16(pos, true);
    pos += 2;
    return v;
  };
  const u16 = () => {
    const v = view.getUint16(pos, true);
    pos += 2;
    return v;
  };
  const i32 = () => {
    const v = view.getInt32(pos, true);
    pos += 4;
    return v;
  };
  const i64 = () => {
    const v = view.getBigInt64(pos, true);
    pos += 8;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(pos, true);
    pos += 4;
    return v;
  };
  const f64 = () => {
    const v = view.getFloat64(pos, true);
    pos += 8;
    return v;
  };
  const str = () => {
    const len = u16();
    const s = decoder.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };

  function payload(tagId: number): ParsedNbt {
    switch (tagId) {
      case 1:
        return u8();
      case 2:
        return i16();
      case 3:
        return i32();
      case 4:
        return i64();
      case 5:
        return f32();
      case 6:
        return f64();
      case 8:
        return str();
      case 9: {
        const itemType = u8();
        const count = i32();
        const items: ParsedNbt[] = [];
        for (let i = 0; i < count; i++) items.push(payload(itemType));
        return items;
      }
      case 10: {
        const obj: { [key: string]: ParsedNbt } = {};
        for (;;) {
          const childType = u8();
          if (childType === 0) break;
          const name = str();
          obj[name] = payload(childType);
        }
        return obj;
      }
      default:
        throw new Error(`Unsupported tag: ${tagId}`);
    }
  }

  const rootType = u8();
  if (rootType !== 10) throw new Error('Root is not a compound');
  const name = str();
  return { name, value: payload(10) };
}
