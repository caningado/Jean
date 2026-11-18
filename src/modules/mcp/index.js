// Servidor MCP: liga o Claude (app do Claude, inclusive no celular e no modo voz) ao sistema.
// Fica em /mcp, com o transporte "Streamable HTTP" do SDK oficial do MCP.
// Só entra quem passou pelo login (OAuth com telefone e PIN do dono, veja oauth.js).
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { nowIso } from '../../lib/util.js';
import { registerTools } from './tools.js';
import { caixaMigrations, createCaixa, registerCaixaTools } from './caixa.js';
import { migrations, createOAuthProvider, createLoginGuard, loginBodyParser, clientIp, owners } from './oauth.js';

export const MCP_PATH = '/mcp';

const INSTRUCTIONS = `Sistema do guincho Towing J&J (empresa nos EUA; o dono também tem a Towing VIP LLC no mesmo sistema). Fale sempre em português do Brasil, de forma simples: o dono costuma usar por voz, dirigindo.
Regras:
- Antes de criar ou alterar qualquer coisa (serviço, situação, pagamento, motorista, apelido), leia os dados para o dono e só chame a ferramenta depois que ele confirmar.
- Antes de criar serviço, use buscar_cliente para não duplicar cliente. Se vierem vários com o mesmo nome, leia telefone, último carro e endereços e pergunte qual é.
- Quando faltar dado obrigatório, pergunte ao dono. Não invente endereço, telefone, preço nem VIN.
- Para o preço, use calcular_preco (milhas pelo Google Maps e sugestão pelo que o dono já cobrou) e leia a sugestão para ele; o preço final é o que o dono disser.
- Quando o dono pedir um endereço, fale o endereço e mostre o link do Google Maps como link clicável.
- Não existe ferramenta para apagar serviço.
- Fotos que o dono mandou ao Jay: use ver_foto_caixa para ver a imagem (carro, placa, VIN). Ao marcar_caixa_lida com o número do serviço, as fotos vão junto para o serviço e para o motorista. Fotos guardadas num serviço: ver_fotos_servico. Os contatos da agenda do celular do dono estão nos clientes: use buscar_cliente. Serviços com dia e hora: agenda e agendar_servico.
- O dono manda serviços, localizações e recados para o Jay (robô do WhatsApp); leia com caixa_de_entrada, organize com ele e só crie o serviço quando ele mandar. Depois marque as mensagens usadas com marcar_caixa_lida.
- Dinheiro em dólar (US$). Formas de pagamento: Zelle, dinheiro, cartão (Square entra como cartão), cheque, Brasil, seguradora.`;

// Endereço público do sistema (no Render vem sozinho; no computador, localhost).
export function baseUrl(ctx) {
  return ctx.config.publicUrl || `http://localhost:${ctx.config.port}`;
}

// Um servidor novo a cada pedido ("sem sessão"): nada fica guardado na memória entre um pedido
// e outro, então funciona igual depois de cada deploy ou reinício do Render.
export function createMcpServer(ctx, user) {
  const server = new McpServer(
    { name: 'towing-jj', title: 'Towing J&J', version: '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'teste',
    {
      title: 'Teste de conexão',
      description: 'Confere se o Claude está ligado ao sistema do guincho. Não lê nem muda nenhum dado.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: `Conectado ao sistema ${ctx.config.companyName || 'Towing J&J'} como ${user.name}. Hora no servidor: ${nowIso()}.`,
        },
      ],
    })
  );

  registerTools(server, ctx, user);
  registerCaixaTools(server, ctx, user);
  return server;
}

// Os limites do SDK contam por endereço de quem pede (o Render passa no X-Forwarded-For).
const rateLimit = { keyGenerator: clientIp, validate: false };

export default {
  name: 'mcp',
  label: 'Conector do Claude (MCP)',
  migrations: [...migrations, ...caixaMigrations],

  setup(ctx) {
    ctx.api.caixa = createCaixa(ctx);
    try {
      ctx.api.caixa.backfill();
    } catch (err) {
      ctx.log('Caixa: não consegui levar as fotos antigas para os serviços', err.message);
    }
  },

  publicRoutes(app, ctx) {
    const guard = createLoginGuard({
      onLock: (kind) => {
        const text =
          kind === 'geral'
            ? '⚠️ Alguém errou o telefone/PIN no login do conector do Claude muitas vezes. Travei esse login por 1 hora. Se não foi você, troque o seu PIN no painel.'
            : '⚠️ Alguém errou o PIN do seu telefone 10 vezes no login do conector do Claude. Travei esse login por 24 horas. Se não foi você, troque o seu PIN no painel.';
        ctx.log(`MCP: login do conector TRAVADO (${kind}).`);
        for (const owner of owners(ctx)) Promise.resolve(ctx.send(owner.phone, text)).catch(() => {});
      },
    });
    const provider = createOAuthProvider(ctx, guard);

    // As rotas do login dependem do endereço público; montadas no primeiro pedido.
    let auth = null;
    const build = () => {
      if (auth) return auth;
      const base = baseUrl(ctx);
      const resourceUrl = new URL(MCP_PATH, base);
      auth = {
        router: mcpAuthRouter({
          provider,
          issuerUrl: new URL(base),
          resourceServerUrl: resourceUrl,
          resourceName: ctx.config.companyName || 'Towing J&J',
          authorizationOptions: { rateLimit },
          tokenOptions: { rateLimit },
          clientRegistrationOptions: { rateLimit, clientSecretExpirySeconds: 0 },
          revocationOptions: { rateLimit },
        }),
        bearer: requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) }),
      };
      return auth;
    };

    // /authorize, /token, /register, /revoke e os /.well-known do OAuth.
    const AUTH_PATHS = ['/authorize', '/token', '/register', '/revoke', '/.well-known/oauth-'];
    app.use((req, res, next) => (AUTH_PATHS.some((p) => req.path.startsWith(p)) ? build().router(req, res, next) : next()));

    app.post(`${MCP_PATH}/login`, loginBodyParser, (req, res) => provider.loginHandler(req, res));

    app.post(
      MCP_PATH,
      (req, res, next) => build().bearer(req, res, next),
      express.json({ limit: '1mb' }),
      async (req, res) => {
        const user = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.auth.extra.userId);
        const server = createMcpServer(ctx, user);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          ctx.log('MCP: erro', err);
          if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro no servidor.' }, id: null });
          }
        }
      }
    );

    // Sem sessão, não há canal aberto (GET) nem sessão para encerrar (DELETE).
    const notAllowed = (req, res) =>
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
    app.get(MCP_PATH, notAllowed);
    app.delete(MCP_PATH, notAllowed);
  },
};
