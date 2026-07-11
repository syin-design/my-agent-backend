import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').limit(1);
  if (error) {
    return res.status(500).json({ status: 'error', message: '数据库连接失败', detail: error.message });
  }
  res.json({ status: 'ok', message: '服务正常，数据库已连接' });
});

// 聊天接口（支持豆包）
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const apiKey = process.env.DOUBAO_API_KEY;
    const modelId = process.env.DOUBAO_MODEL_ID;

    if (!apiKey || !modelId) {
      return res.status(500).json({ error: '豆包 API Key 或模型 ID 未配置' });
    }

    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: message }],
        stream: false,
        max_tokens: 1024,
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || '豆包 API 调用失败');
    }

    const reply = data.choices?.[0]?.message?.content || '（未收到有效回复）';
    res.json({ reply });
  } catch (error) {
    console.error('豆包 API 调用失败:', error);
    res.status(500).json({ error: error.message || 'AI 服务暂时不可用' });
  }
});

app.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});