// Voz do robô: transforma a resposta em áudio com o Gemini (Google). Precisa de GEMINI_API_KEY.
// O Gemini devolve o som "cru" (PCM); para o WhatsApp vira .ogg (mensagem de voz) com o ffmpeg,
// e para o painel vira .wav, que o navegador toca direto.
import { spawn } from 'node:child_process';

// Respostas compridas (lista de comandos, resumos) ficam só no texto.
export const MAX_FALA = 600;

// Tira o que não se lê em voz alta: *negrito*, emojis, links.
export function textoParaFala(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Texto -> { pcm, rate } (16 bits, mono).
export async function speak(ctx, text, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${ctx.config.geminiTtsModel}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Leia em português do Brasil, num tom simpático e natural, de colega de trabalho:\n${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ctx.config.geminiTtsVoice } } },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Gemini (voz) respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data || p.inline_data?.data);
  const inline = part?.inlineData || part?.inline_data;
  if (!inline) throw new Error('Gemini (voz) não devolveu áudio.');
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType || inline.mime_type || '')?.[1]) || 24000;
  return { pcm: Buffer.from(inline.data, 'base64'), rate };
}

// PCM -> .wav (o navegador toca).
export function toWav({ pcm, rate }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// PCM -> .ogg Opus (mensagem de voz do WhatsApp).
export function toOgg({ pcm, rate }) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', (e) => reject(new Error(`ffmpeg não encontrado: ${e.message}`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg falhou: ${err.slice(0, 200)}`))));
    ff.stdin.end(pcm);
  });
}
