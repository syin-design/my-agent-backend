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


// ========== 语音合成接口 (手动WebSocket实现，兼容火山引擎协议) ==========
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length > 1000) return res.status(400).json({ error: '文本为空或过长' });

    const apiKey = process.env.DOUBAO_TTS_API_KEY;
    const voiceId = process.env.TTS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(500).json({ error: 'TTS 配置不完整，请检查环境变量' });
    }

    console.log('🔊 TTS 接口被调用，使用的是手动 WebSocket 实现 v2');
    const https = await import('https');
    const crypto = await import('crypto');
    const connectId = crypto.randomUUID();
    const host = 'openspeech.bytedance.com';
    const path = '/api/v3/tts/bidirection';

    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'GET',
      headers: {
        'Host': host,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'seed-icl-2.0',
        'X-Api-Connect-Id': connectId,
        'X-Control-Require-Usage-Tokens-Return': '*',
      }
    };

    const wsRequest = https.request(options);
    wsRequest.end();

    wsRequest.on('upgrade', (serverRes, socket, head) => {
      let audioChunks = [];
      let sessionId = null;
      let errorMessage = null;

            function sendFrame(payload) {
        const data = Buffer.from(payload, 'utf8');
        const length = data.length;
        // 生成4字节随机掩码
        const mask = crypto.randomBytes(4);
        
        let header;
        if (length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + text opcode
          header[1] = 0x80 | length; // 设置掩码位 + 长度
        } else if (length < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126; // 掩码位 + 扩展长度标识
          header.writeUInt16BE(length, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 0x80 | 127; // 掩码位 + 64位扩展长度
          header.writeBigUInt64BE(BigInt(length), 2);
        }
        
        // 拼接：头部 + 掩码 + 掩码后的数据
        const maskedData = Buffer.alloc(length);
        for (let i = 0; i < length; i++) {
          maskedData[i] = data[i] ^ mask[i % 4];
        }
        
        socket.write(Buffer.concat([header, mask, maskedData]));
      }

      sendFrame(JSON.stringify({ EventType: 'StartConnection' }));

      let buffer = Buffer.alloc(0);

      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let payloadLength = buffer[1] & 0x7f;
          let offset = 2;

          if (payloadLength === 126) {
            if (buffer.length < 4) break;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLength === 127) {
            if (buffer.length < 10) break;
            payloadLength = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          if (buffer.length < offset + payloadLength) break;

          const payload = buffer.slice(offset, offset + payloadLength);
          buffer = buffer.slice(offset + payloadLength);

          if (opcode === 0x02) {
            audioChunks.push(payload);
          } else if (opcode === 0x01) {
            try {
              const responseList = JSON.parse(payload.toString('utf8'));
              for (const msg of responseList) {
                if (msg.EventType === 'ConnectionStarted') {
                  sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
                  sendFrame(JSON.stringify({
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
                  sendFrame(JSON.stringify({
                    EventType: 'TaskRequest',
                    session_id: sessionId,
                    req_params: { text: text },
                  }));
                } else if (msg.EventType === 'TTSSentenceEnd') {
                  sendFrame(JSON.stringify({
                    EventType: 'FinishSession',
                    session_id: sessionId,
                  }));
                } else if (msg.EventType === 'SessionFinished') {
                  sendFrame(JSON.stringify({ EventType: 'FinishConnection' }));
                } else if (msg.EventType === 'ConnectionFinished') {
                  socket.end();
                } else if (msg.EventType === 'ConnectionFailed') {
                  errorMessage = msg.Payload?.message || '连接失败';
                  socket.end();
                } else if (msg.EventType === 'SessionFailed') {
                  errorMessage = msg.Payload?.message || 'TTS 合成失败';
                  socket.end();
                }
              }
            } catch (e) {
              audioChunks.push(payload);
            }
          }
        }
      });

      socket.on('end', () => {
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
        const firstBytes = audioBuffer.slice(0, 20).toString('utf8');
        if (firstBytes.includes('{') || firstBytes.includes('error')) {
          if (!res.headersSent) {
            res.status(500).json({ error: '音频数据包含错误信息: ' + audioBuffer.toString('utf8').substring(0, 200) });
          }
          return;
        }

        const base64Audio = audioBuffer.toString('base64');
        if (!res.headersSent) {
          res.json({
            audio: base64Audio,
            format: 'pcm',
            sampleRate: 24000,
            channels: 1,
            bitDepth: 16,
          });
        }
      });

      socket.on('error', (err) => {
        console.error('Socket错误:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'TTS 连接中断' });
        }
      });
    });

    wsRequest.on('error', (error) => {
      console.error('WebSocket 请求错误:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'TTS 服务连接失败' });
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