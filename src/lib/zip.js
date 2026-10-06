// Arquivo .zip simples, escrito aos pedaços (dá para mandar direto na resposta,
// sem juntar tudo na memória). O .xlsx também é um zip de arquivos XML.
import zlib from 'node:zlib';

// write(buffer) recebe cada pedaço na ordem. compress=false guarda como está
// (fotos .jpg já são comprimidas; comprimir de novo só gasta tempo).
export function createZip(write) {
  const centrals = [];
  let offset = 0;
  let count = 0;
  const put = (buf) => {
    write(buf);
    offset += buf.length;
  };
  return {
    add(name, content, { compress = true } = {}) {
      const nameBuf = Buffer.from(name, 'utf8');
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      const packed = compress ? zlib.deflateRawSync(data) : data;
      const method = compress ? 8 : 0;
      const crc = zlib.crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // versão
      local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10); // hora
      local.writeUInt16LE(0x21, 12); // data (1980-01-01)
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(packed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      count++;

      put(local);
      put(nameBuf);
      put(packed);
    },
    end() {
      const centralBuf = Buffer.concat(centrals);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(centralBuf.length, 12);
      end.writeUInt32LE(offset, 16);
      put(centralBuf);
      put(end);
    },
  };
}

// Zip inteiro na memória (para arquivos pequenos, como o .xlsx).
export function zipToBuffer(files) {
  const chunks = [];
  const zip = createZip((buf) => chunks.push(buf));
  for (const [name, content] of Object.entries(files)) zip.add(name, content);
  zip.end();
  return Buffer.concat(chunks);
}
