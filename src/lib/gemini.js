// Chamada ao Gemini (Google) que devolve JSON num formato combinado (schema).
// Usado pelos comandos de voz do painel e pelo robô do WhatsApp. Precisa de GEMINI_API_KEY.
export async function askGemini(ctx, opts, fetchImpl = globalThis.fetch) {
  const first = opts.model || ctx.config.geminiVoiceModel;
  // Ordem: o modelo pedido, o outro modelo e as reservas extras (GEMINI_RESERVAS).
  const models = [...new Set([first, ctx.config.geminiVoiceModel, ctx.config.geminiModel, ...(ctx.config.geminiReservas || [])].filter(Boolean))];
  let last;
  // Google lotado ("high demand", 503) ou lento costuma passar em segundos: dá uma 2ª volta depois de esperar.
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise((r) => setTimeout(r, ctx.config.geminiRetryMs ?? 2000));
    for (const model of models) {
      try {
        return await callGemini(ctx, { ...opts, model }, fetchImpl);
      } catch (err) {
        last = err;
        ctx.log?.(`Gemini: ${model} falhou (${err.message.slice(0, 120)})`);
        // Erro que não passa tentando de novo (chave errada, pedido inválido): para logo.
        if (/respondeu (400|401|403)\b/.test(err.message)) throw err;
      }
    }
  }
  throw last;
}

async function callGemini(ctx, { prompt, audio = null, mimeType = '', schema, model }, fetchImpl) {
  const parts = audio ? [{ inline_data: { mime_type: mimeType, data: audio.toString('base64') } }, { text: prompt }] : [{ text: prompt }];
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    }),
    signal: AbortSignal.timeout(ctx.config.geminiTimeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`Gemini respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}
