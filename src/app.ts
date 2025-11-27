import express, { Express } from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler';
import routes from './routes';

const app: Express = express();

app.use(cors({
  origin: 'http://localhost:3009',
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', routes);

app.use(errorHandler);

export default app;
