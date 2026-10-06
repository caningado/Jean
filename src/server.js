import { loadConfig } from './config.js';
import { createContext, createApp } from './app.js';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

app.listen(config.port, () => {
  ctx.log(`${config.companyName} rodando em http://localhost:${config.port}`);
  ctx.log(`Módulos ligados: ${ctx.loaded.map((m) => m.name).join(', ')}`);
});
