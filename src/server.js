import { loadConfig } from './config.js';
import { createContext, createApp } from './app.js';
import { startDaily } from './lib/daily.js';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
startDaily(ctx);

app.listen(config.port, () => {
  ctx.log(`${config.companyName} rodando em http://localhost:${config.port}`);
  ctx.log(`Módulos ligados: ${ctx.loaded.map((m) => m.name).join(', ')}`);
});
