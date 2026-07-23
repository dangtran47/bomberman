import { createApp } from './app';

const port = Number(process.env.PORT ?? 2567);

const { gameServer } = createApp();
void gameServer.listen(port).then(() => {
  console.log(`bomberman server listening on :${port}`);
});
