import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '服务正常' });
});

app.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});