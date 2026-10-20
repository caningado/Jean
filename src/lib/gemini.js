// Chamada ao Gemini (Google) que devolve JSON num formato combinado (schema).
// Usado pelos comandos de voz do painel e pelo robô do WhatsApp. Precisa de GEMINI_API_KEY.
export async function askGemini(ctx, opts, fetchImpl = globalThis.fetch) {
  const model = opts.model || ctx.config.geminiVoiceModel;
  try {
    return await callGemini(ctx, { ...opts, model }, fetchImpl);
  } catch (err) {
    // Modelo pedido falhou (limite do plano grátis, nome trocado pelo Google...): tenta o modelo leve.
    const reserva = ctx.config.geminiVoiceModel;
    if (!reserva || reserva === model) throw err;
    ctx.log?.(`Gemini: ${model} falhou (${err.message.slice(0, 120)}), usando ${reserva}`);
    return callGemini(ctx, { ...opts, model: reserva }, fetchImpl);
  }
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
    signal: AbortSignal.timeout(30000),
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
