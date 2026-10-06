# Como criar um módulo

Cada função do sistema (VIN, fotos, pagamentos, despesas, WhatsApp) é um módulo. O núcleo
(`src/core`) cuida da equipe, dos contatos e dos serviços. Um módulo novo não precisa mexer
nos outros.

1. Crie `src/modules/<nome>/index.js` exportando um objeto como o abaixo.
2. Importe e acrescente o módulo em `AVAILABLE_MODULES` (`src/app.js`).
3. Ligue o módulo em `MODULES` no `.env` (ou acrescente em `ALL_MODULES` em `src/config.js`).

Todos os campos são opcionais, menos `name`.

```js
export default {
  name: 'meu-modulo',          // usado em MODULES e nas migrações
  label: 'Meu módulo',         // nome que aparece para o usuário

  // SQL que roda uma vez só, em ordem. Nunca altere uma migração já publicada:
  // acrescente uma nova no fim da lista.
  migrations: ['CREATE TABLE ...'],

  // Chamado depois que todos os módulos carregaram. Use ctx.api.<nome> para
  // oferecer funções a outros módulos.
  setup(ctx) {},

  // Rotas do painel (já com login). `api` é um express.Router montado em /api.
  routes(api, ctx) {},

  // Rotas sem login (ex.: webhooks), direto no app do express.
  publicRoutes(app, ctx) {},

  // Comandos do robô. A primeira palavra da mensagem escolhe o comando.
  commands: [
    { names: ['exemplo'], help: '*exemplo* – o que faz', run: ({ ctx, user, args, rawArgs, text }) => 'resposta' },
  ],

  // Conversas em etapas (perguntas e respostas). Comece com ctx.bot.startFlow(user, 'nome', dados).
  flows: { nome: { steps: [{ key, ask(data, ctx), parse(text, { ctx, user, data }), optional, skip(data, ctx) }], finish({ ctx, user, data }) } },

  // Recebe fotos mandadas ao robô. Devolva texto para responder ou null para deixar outro módulo tratar.
  onMedia: async ({ ctx, user, media: { buffer, mime }, caption }) => null,

  serviceHint: 'Dica mostrada ao criar um serviço pelo robô',
  serviceDetail: ({ ctx, service }) => ({ /* campos extras na tela do serviço */ }),
  onServiceDone: ({ ctx, service }) => [/* avisos ao finalizar o serviço */],
  summary: ({ ctx, since, userId }) => ({ /* números para o resumo */ }),
  summaryLines: (summary) => [/* linhas do resumo no WhatsApp */],

  // Planilha (módulo planilha): abas próprias e colunas extras na aba Serviços.
  // type: 'text', 'number', 'money' (dólares) ou 'date'.
  exportSheets: ({ ctx, from, to, userId }) => [{ name: 'Aba', columns: [{ header, width, type }], rows: [[...]] }],
  exportColumns: (ctx) => [{ header, width, type, value: (service) => ... }],
  // Arquivos que vão junto no .zip "planilha com fotos" (name = caminho dentro do zip).
  exportFiles: ({ ctx, from, to, userId }) => [{ name: 'fotos/Serviço 1/antes.jpg', path: '/caminho/no/disco.jpg' }],
};
```

`ctx` tem: `config`, `db` (SQLite), `data` (contatos, serviços, equipe), `bot`, `api`
(funções dos outros módulos), `send(telefone, texto)` e `log`.
