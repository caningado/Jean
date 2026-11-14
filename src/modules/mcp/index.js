// Servidor MCP: liga o Claude (app do Claude, inclusive no celular e no modo voz) ao sistema.
// Fica em /mcp, com o transporte "Streamable HTTP" do SDK oficial do MCP.
// Etapa 2: só uma ferramenta de teste, que não mostra nenhum dado do sistema.
// O login (OAuth) e as ferramentas de serviço entram nas próximas etapas.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { nowIso } from '../../lib/util.js';

export const MCP_PATH = '/mcp';

// Um servidor novo a cada pedido ("sem sessão"): nada fica guardado na memória entre um pedido
// e outro, então funciona igual depois de cada deploy ou reinício do Render.
export function createMcpServer(ctx) {
  const server = new McpServer(
    { name: 'towing-jj', title: 'Towing J&J', version: '0.1.0' },
    {
      instructions:
        'Sistema do guincho Towing J&J. Responda em português do Brasil. Por enquanto só existe a ferramenta de teste.',
    }
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
      content: [{ type: 'text', text: `Conectado ao sistema ${ctx.config.companyName || 'Towing J&J'}. Hora no servidor: ${nowIso()}.` }],
    })
  );

  return server;
}

export default {
  name: 'mcp',
  label: 'Conector do Claude (MCP)',

  publicRoutes(app, ctx) {
    app.post(MCP_PATH, express.json({ limit: '1mb' }), async (req, res) => {
      const server = createMcpServer(ctx);
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
    });

    // Sem sessão, não há canal aberto (GET) nem sessão para encerrar (DELETE).
    const notAllowed = (req, res) =>
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
    app.get(MCP_PATH, notAllowed);
    app.delete(MCP_PATH, notAllowed);
  },
};
