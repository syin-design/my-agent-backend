import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';


const app = express();
const PORT = process.env.PORT || 3000;

// ========== Supabase 客户端 ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(cors());
app.use(express.json());

// ========== 健康检查 ==========
app.get('/health', async (req, res) => {
  const { error } = await supabase.from('settings').select('*').limit(1);
  if (error) {
    return res.status(500).json({ status: 'error', message: '数据库连接失败', detail: error.message });
  }
  res.json({ status: 'ok', message: '服务正常，数据库已连接' });
});

// ========== 辅助函数：获取或创建设置 ==========
async function getSettings() {
  const { data } = await supabase.from('settings').select('*').limit(1).single();
  return data || {
    system_prompt: '你是一个贴心、知识渊博的AI助手，回答简洁生动，富有温度。',
    temperature: 0.7,
    max_context_rounds: 20,
    max_reply_tokens: 1024
  };
}

// ========== 获取设置接口 ==========
app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .single();
    if (error) throw error;
    res.json({ settings: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 更新设置接口 ==========
app.put('/api/settings', async (req, res) => {
  try {
    const { system_prompt, temperature, max_context_rounds, max_reply_tokens } = req.body;
    const updates = {};
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (temperature !== undefined) updates.temperature = temperature;
    if (max_context_rounds !== undefined) updates.max_context_rounds = max_context_rounds;
    if (max_reply_tokens !== undefined) updates.max_reply_tokens = max_reply_tokens;
    updates.updated_at = new Date();

    const { error } = await supabase
      .from('settings')
      .update(updates)
      .eq('id', 1);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ========== 语音合成接口 (官方双向流式 WebSocket TTS) ==========
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length > 1000) return res.status(400).json({ error: '文本为空或过长' });

    const apiKey = process.env.DOUBAO_TTS_API_KEY;
    const voiceId = process.env.TTS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(500).json({ error: 'TTS 配置不完整，请检查环境变量' });
    }

    // 动态导入 WebSocket
    const WebSocket = (await import('ws')).default;
    const url = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
    const connectId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

    const ws = new WebSocket(url, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'seed-icl-2.0',     // 声音复刻大模型 2.0
        'X-Api-Connect-Id': connectId,
      }
    });

    let audioChunks = [];
    let sessionId = null;
    let errorMessage = null;

    ws.on('open', () => {
      // ① 建立连接
      ws.send(JSON.stringify({ EventType: 'StartConnection' }));
    });

    ws.on('message', (data) => {
      try {
        const responseList = JSON.parse(data.toString());
        for (const msg of responseList) {
          if (msg.EventType === 'ConnectionStarted') {
            // ② 创建会话
            sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
            ws.send(JSON.stringify({
              EventType: 'StartSession',
              session_id: sessionId,
              req_params: {
                speaker: voiceId,
                audio_params: {
                  format: 'mp3',
                  sample_rate: 24000,
                },
              },
            }));
          } else if (msg.EventType === 'SessionStarted') {
            // ③ 发送文本（只传 text）
            ws.send(JSON.stringify({
              EventType: 'TaskRequest',
              session_id: sessionId,
              req_params: {
                text: text,
              },
            }));
            // ④ 结束会话
            ws.send(JSON.stringify({
              EventType: 'FinishSession',
              session_id: sessionId,
            }));
          } else if (msg.EventType === 'SessionFinished') {
            // ⑤ 结束连接
            ws.send(JSON.stringify({ EventType: 'FinishConnection' }));
          } else if (msg.EventType === 'ConnectionFinished') {
            ws.close();
          } else if (msg.EventType === 'SessionFailed') {
            errorMessage = msg.Payload?.message || 'TTS 合成失败';
            ws.close();
          }
        }
      } catch (e) {
        // ⑥ 音频二进制帧
        if (Buffer.isBuffer(data)) {
          audioChunks.push(data);
        } else if (data instanceof ArrayBuffer) {
          audioChunks.push(Buffer.from(data));
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket 错误:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'TTS 服务连接失败' });
      }
    });

    ws.on('close', () => {
      if (errorMessage) {
        if (!res.headersSent) {
          res.status(500).json({ error: errorMessage });
        }
        return;
      }

      if (audioChunks.length === 0) {
        if (!res.headersSent) {
          res.status(500).json({ error: '未收到音频数据' });
        }
        return;
      }

      const audioBuffer = Buffer.concat(audioChunks);
      const base64Audio = audioBuffer.toString('base64');

      if (!res.headersSent) {
        res.json({ audio: base64Audio, format: 'mp3' });
      }
    });

  } catch (error) {
    console.error('TTS 接口出错:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '语音合成失败' });
    }
  }
});


// ========== 核心聊天接口 ==========
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const apiKey = process.env.DOUBAO_API_KEY;
    const modelId = process.env.DOUBAO_MODEL_ID;

    if (!apiKey || !modelId) {
      return res.status(500).json({ error: '豆包 API Key 或模型 ID 未配置' });
    }

    // ----- 1. 如果没有 sessionId，自动创建新会话 -----
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const { data: newSession } = await supabase
        .from('sessions')
        .insert({ name: message.slice(0, 25) + (message.length > 25 ? '...' : '') })
        .select('id')
        .single();
      currentSessionId = newSession.id;
    }

    // ----- 2. 存入用户消息 -----
    await supabase.from('messages').insert({
      sessionid: currentSessionId,
      role: 'user',
      content: message
    });

    // ----- 3. 加载历史消息（最近20轮）-----
    const { data: historyMessages } = await supabase
      .from('messages')
      .select('role, content')
      .eq('sessionid', currentSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(40); // 20轮 = 40条（用户+AI交替）

    // ----- 4. 获取系统设置 -----
    const settings = await getSettings();

    // ----- 5. 组装上下文 -----
    const messagesForAI = [
      { role: 'system', content: settings.system_prompt },
      ...(historyMessages || []).map(m => ({ role: m.role, content: m.content }))
    ];

    // ----- 6. 调用豆包 API -----
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: messagesForAI,
        stream: false,
        max_tokens: settings.max_reply_tokens || 1024,
        temperature: settings.temperature || 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || '豆包 API 调用失败');
    }

    const reply = data.choices?.[0]?.message?.content || '（未收到有效回复）';

    // ----- 7. 存入 AI 回复 -----
    await supabase.from('messages').insert({
      sessionid: currentSessionId,
      role: 'assistant',
      content: reply
    });

    // ----- 8. 更新会话时间 -----
    await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', currentSessionId);

    // ----- 9. 返回结果 -----
    res.json({ reply, sessionId: currentSessionId });
  } catch (error) {
    console.error('聊天接口出错:', error);
    res.status(500).json({ error: error.message || 'AI 服务暂时不可用' });
  }
});

// ========== 获取会话列表 ==========
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessions: data });
});

// ========== 获取某个会话的消息 ==========
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('sessionid', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data });
});

// ========== 重命名会话 ==========
app.patch('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const { error } = await supabase.from('sessions').update({ name }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ========== 删除会话（同时删除其下所有消息） ==========
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  // 先删消息，再删会话
  await supabase.from('messages').delete().eq('sessionid', id);
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});