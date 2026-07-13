import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`MarketMe API ouvindo em http://localhost:${config.port}`);
});
