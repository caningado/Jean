// Inteligência do robô (Gemini): entende o que a equipe escreve ou fala no WhatsApp do jeito dela
// ("abasteci 80 de diesel", áudio "peguei o carro do João") e traduz para um comando do robô.
// Sem GEMINI_API_KEY o robô funciona só com os comandos de sempre.
import { askGemini } from '../lib/gemini.js';

// Comandos que mexem em dinheiro ou fecham coisas: o robô pede "sim" antes de fazer.
export const CONFIRM_FIRST = ['entregue', 'pago', 'gasto', 'recolhi', 'fiz', 'odometro', 'empresa'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    comando: { type: 'STRING' },
    cliente: { type: 'STRING' },
    telefone: { type: 'STRING' },
    retirada: { type: 'STRING' },
    destino: { type: 'STRING' },
    veiculo: { type: 'STRING' },
    milhas: { type: 'NUMBER' },
    valor: { type: 'NUMBER' },
    resposta: { type: 'STRING' },
    transcricao: { type: 'STRING' },
  },
};

// O que o robô faz além dos comandos, para a inteligência responder perguntas sem dizer "não entendi".
const SABE_FAZER = `- Lê o VIN de uma foto: é só mandar a foto da etiqueta (porta do motorista, para-brisa ou documento), com ou sem serviço aberto; mostra o carro (ano, marca, modelo). Sem serviço aberto, guarda o VIN e coloca no próximo serviço criado.
- Guarda fotos do carro antes (retirada) e depois (entrega) no serviço aberto.
- Entende áudio e responde por voz quando recebe áudio.
- Cadastra um serviço ditado de uma vez, em qualquer ordem (cliente, telefone, onde pegar, para onde levar, carro, milhas, valor).
- Registra pagamento, despesa, dinheiro em mãos, odômetro, e faz invoice em PDF; o painel do celular mostra tudo.`;

function prompt(ctx, user, text, situacao = '') {
  const list = ctx.commands.map((c) => c.help).filter(Boolean).join('\n');
  return `Você é o robô de WhatsApp da equipe de uma empresa de guincho nos EUA (Flórida). Quem fala é ${user.role === 'dono' ? `o dono/ADM ${user.name}` : `o motorista ${user.name}`}, em português do Brasil, muitas vezes informal, com erros de digitação ou misturando inglês. Valores em dólar, distâncias em milhas.
O que o robô sabe fazer:
${SABE_FAZER}
Os comandos que o robô entende são estes (o primeiro trecho em *negrito* é o jeito de escrever):
${list}

Traduza o pedido para UM comando, escrito em "comando" do jeito que se digitaria (ex.: "gasto 80 diesel", "pago 150 zelle", "odometro 123400", "entregue", "abrir 12", "resumo mes").
- Se só falou o nome de um comando ("ajuda", "novo serviço", "fila", "caixa"), escreva esse comando em "comando" ("ajuda", "novo"...).
- "peguei o carro", "carro no guincho": não muda nada no robô; responda em "resposta" que anotou e lembre de mandar as fotos (*antes*).
- Serviço novo ditado ("serviço pro João, pegar na Alafaya, levar pra Ribas, Civic, 150"): comando "novo" e preencha só o que foi dito em cliente, telefone (só números), retirada, destino, veiculo (com a placa, se disse), milhas, valor.
- Pedido de serviço encaminhado/colado (várias linhas com "Pickup", "Entrega", "Drop off", endereços, carro, valor como "$180", "Contato do cliente: Nome telefone"), mesmo em inglês ou sem dizer "novo": é serviço novo. Comando "novo"; "Contato do cliente" vira cliente e telefone; Pickup/retirada vira retirada; Entrega/drop off/destino vira destino.
- Cumprimento ou conversa sem pedido ("bom dia, tudo certo?"): deixe "comando" vazio e responda como um colega, curto e simpático, perguntando em que pode ajudar. Nunca mande a lista de comandos sem pedirem.
- Pergunta ("você consegue...?", "como faço...?", "qual o VIN?", "qual o endereço?"): deixe "comando" vazio e RESPONDA a pergunta em "resposta", de forma natural e útil, como um colega (português, no máximo 3 frases). Use o que o robô sabe fazer e a situação abaixo. Se a resposta não estiver na situação, diga onde achar (comando ou painel); nunca invente dados.
- Só se não der mesmo para saber o que ele quer, deixe "comando" vazio e pergunte em "resposta" o que ele quis dizer, citando o que você entendeu.
- "resposta" nunca fica vazia quando "comando" estiver vazio.
Nunca invente valores, nomes ou números que não foram ditos. Em "transcricao", escreva o que a pessoa falou ou escreveu.
${situacao ? `Situação agora:\n${situacao}\n` : ''}${text ? `Mensagem: """${text.slice(0, 1500)}"""` : 'A mensagem é o áudio anexado.'}`;
}

export function createAi(ctx) {
  const enabled = () => Boolean(ctx.config.geminiApiKey);

  // Texto livre ou áudio -> { comando, novo, resposta, transcricao }.
  async function understand(user, { text = '', audio = null, situacao = '' }) {
    const a = await askGemini(ctx, { prompt: prompt(ctx, user, text, situacao), audio: audio?.buffer, mimeType: audioType(audio?.mime), schema: SCHEMA });
    const str = (k, max = 300) => String(a[k] ?? '').trim().slice(0, max);
    const num = (k) => (Number.isFinite(Number(a[k])) && Number(a[k]) > 0 ? Number(a[k]) : null);
    return {
      comando: str('comando', 200).replace(/^\*|\*$/g, ''),
      novo: {
        cliente: str('cliente', 120),
        telefone: str('telefone', 30).replace(/[^\d+]/g, ''),
        retirada: str('retirada'),
        destino: str('destino'),
        veiculo: str('veiculo', 120),
        milhas: num('milhas'),
        valor: num('valor'),
      },
      resposta: str('resposta', 600),
      transcricao: str('transcricao', 500),
    };
  }

  // Resposta a uma pergunta do robô (áudio, ou texto comprido no cadastro de serviço).
  // Devolve { texto, novo }: "texto" é a resposta da pergunta; no cadastro de serviço, "novo" traz
  // o resto que a pessoa já falou junto (destino, carro, valor...), para o robô não perguntar de novo.
  async function answer({ audio = null, text = '' }, question, { service = false } = {}) {
    const fields = service
      ? { cliente: { type: 'STRING' }, telefone: { type: 'STRING' }, retirada: { type: 'STRING' }, destino: { type: 'STRING' }, veiculo: { type: 'STRING' }, milhas: { type: 'NUMBER' }, valor: { type: 'NUMBER' } }
      : {};
    const a = await askGemini(ctx, {
      prompt: `Um motorista de guincho (EUA, fala português do Brasil, às vezes inglês) respondeu ${audio ? 'por áudio' : 'por escrito'} esta pergunta do robô:\n"""${String(question).slice(0, 800)}"""\n${text ? `Resposta: """${text.slice(0, 1500)}"""\n` : ''}Escreva em "texto" só a resposta dele para essa pergunta, do jeito mais curto que o robô entende (ex.: o endereço completo como ele disse, "Honda Civic ABC1234", "150", "sim", "pular", "1"). Números por extenso viram algarismos.${service ? '\nEle está cadastrando um serviço de guincho e pode ter falado mais coisas de uma vez, fora de ordem. Preencha também, só com o que ele disse: cliente (nome), telefone (só números), retirada (onde pegar), destino (para onde levar), veiculo (com a placa, se disse), milhas, valor (em dólar). Nunca invente.' : ''}`,
      audio: audio?.buffer,
      mimeType: audio ? audioType(audio.mime) : '',
      schema: { type: 'OBJECT', properties: { texto: { type: 'STRING' }, ...fields } },
    });
    const str = (k, max = 300) => String(a[k] ?? '').trim().slice(0, max);
    const num = (k) => (Number.isFinite(Number(a[k])) && Number(a[k]) > 0 ? Number(a[k]) : null);
    return {
      texto: str('texto', 500),
      novo: service
        ? { cliente: str('cliente', 120), telefone: str('telefone', 30).replace(/[^\d+]/g, ''), retirada: str('retirada'), destino: str('destino'), veiculo: str('veiculo', 120), milhas: num('milhas'), valor: num('valor') }
        : null,
    };
  }

  // Áudio respondendo uma pergunta do robô: devolve só o texto da resposta.
  async function transcribe(audio, question) {
    return (await answer({ audio }, question)).texto;
  }

  // Gate pass / pedido de serviço em PDF (ou foto de documento): tira os dados do serviço.
  async function readDocument({ buffer, mime }) {
    const a = await askGemini(ctx, {
      prompt: `Este documento chegou para uma empresa de guincho nos EUA. Geralmente é um gate pass de leilão (CarMax, Manheim, Copart, IAA...) ou um pedido de reboque. Tire os dados do serviço, só o que estiver escrito, sem inventar:
- veiculo: ano, marca, modelo e cor (ex.: "2020 Ram 1500 Classic branca").
- vin: o VIN de 17 caracteres.
- retirada: endereço completo onde o carro está para pegar ("Pick Up Details"/"Pickup Location"), começando pelo nome do lugar (ex.: "CarMax - Clermont, 16731 State Road 50, Clermont, FL 34711").
- cliente: quem comprou/pediu ("Dealership", "Purchaser" ou "Buyer" — o nome da empresa); telefone: telefone desse cliente (só números), nunca o do leilão.
- destino: endereço de entrega, se o documento disser; senão, o endereço do comprador.
- valor: só se o documento disser o preço do reboque (em dólar).
- observacoes: o que o motorista precisa saber, em português e curto: se o carro não liga ("no runner"), vaga/lote ("Lot Location"), horário de retirada, número do gate pass/release ID, stock #.
- tipo: "gate pass", "pedido de serviço" ou "outro".`,
      audio: buffer,
      mimeType: mime,
      schema: {
        type: 'OBJECT',
        properties: { tipo: { type: 'STRING' }, cliente: { type: 'STRING' }, telefone: { type: 'STRING' }, retirada: { type: 'STRING' }, destino: { type: 'STRING' }, veiculo: { type: 'STRING' }, vin: { type: 'STRING' }, valor: { type: 'NUMBER' }, observacoes: { type: 'STRING' } },
      },
    });
    const str = (k, max = 300) => String(a[k] ?? '').trim().slice(0, max);
    return {
      tipo: str('tipo', 40),
      vin: str('vin', 30).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      observacoes: str('observacoes', 500),
      novo: {
        cliente: str('cliente', 120),
        telefone: str('telefone', 30).replace(/[^\d+]/g, ''),
        retirada: str('retirada'),
        destino: str('destino'),
        veiculo: str('veiculo', 120),
        milhas: null,
        valor: Number.isFinite(Number(a.valor)) && Number(a.valor) > 0 ? Number(a.valor) : null,
      },
    };
  }

  return { enabled, understand, transcribe, answer, readDocument };
}

// O WhatsApp manda áudio como "audio/ogg; codecs=opus": o Gemini quer só "audio/ogg".
function audioType(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return type.startsWith('audio/') ? type : 'audio/ogg';
}
