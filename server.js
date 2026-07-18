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


// ========== 语音合成接口 (火山引擎官方二进制帧协议) ==========
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.length > 1000) return res.status(400).json({ error: '文本为空或过长' });

    const apiKey = process.env.DOUBAO_TTS_API_KEY;
    const voiceId = process.env.TTS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(500).json({ error: 'TTS 配置不完整，请检查环境变量' });
    }

    const https = await import('https');
    const crypto = await import('crypto');
    const connectId = crypto.randomUUID();

    // ========== 火山引擎协议常量 ==========
    const Version = { Version1: 1 };
    const HeaderSize = { HeaderSize4: 1 };
    const MsgType = { FullClientRequest: 0b0001, AudioOnlyServer: 0b1011, FullServerResponse: 0b1001 };
    const MsgFlag = { NoSeq: 0, WithEvent: 0b0100 };
    const Serialization = { JSON: 0b0001 };
    const Compression = { None: 0 };
    const EventType = {
      StartConnection: 1,  FinishConnection: 2,  ConnectionStarted: 50,
      ConnectionFailed: 51, ConnectionFinished: 52, StartSession: 100,
      FinishSession: 102, SessionStarted: 150, SessionFinished: 152,
      SessionFailed: 153, TaskRequest: 200, TTSSentenceEnd: 351
    };

    /**
     * 构建火山引擎自定义二进制帧 (marshal)
     * 帧格式:
     *   Byte 0: 高4位=Version, 低4位=HeaderSize
     *   Byte 1: 高4位=MsgType, 低4位=MsgFlag
     *   Byte 2: 高4位=Serialization, 低4位=Compression
     *   Byte 3+: 可选扩展头（取决于HeaderSize）
     *   Event (4字节大端) — 仅当MsgFlag包含WithEvent时
     *   SessionID长度 + SessionID (uint32大端 + UTF-8) — 仅当Event需要时
     *   Payload长度 + Payload (uint32大端 + raw bytes)
     */
    function marshal(eventType, sessionId, payload) {
      const payloadBuf = Buffer.from(payload, 'utf8');
      const hasEvent = eventType !== undefined;
      const sidBuf = sessionId ? Buffer.from(sessionId, 'utf8') : null;

      // 是否需要写入session_id（根据官方协议，StartConnection/FinishConnection等不写session_id）
      const needsSid = hasEvent &&
        eventType !== EventType.StartConnection &&
        eventType !== EventType.FinishConnection &&
        eventType !== EventType.ConnectionStarted &&
        eventType !== EventType.ConnectionFailed &&
        eventType !== EventType.ConnectionFinished;

      // 计算总长度
      let totalSize = 4 * HeaderSize.HeaderSize4; // 基础头部
      if (hasEvent) totalSize += 4; // Event (int32)
      if (needsSid && sidBuf) totalSize += 4 + sidBuf.length; // SessionID长度 + SessionID
      totalSize += 4 + payloadBuf.length; // Payload长度 + Payload

      const buf = Buffer.alloc(totalSize);
      let offset = 0;

      // Byte 0: Version + HeaderSize
      buf[offset++] = (Version.Version1 << 4) | HeaderSize.HeaderSize4;
      // Byte 1: MsgType + MsgFlag
      const flag = hasEvent ? MsgFlag.WithEvent : MsgFlag.NoSeq;
      buf[offset++] = (MsgType.FullClientRequest << 4) | flag;
      // Byte 2: Serialization + Compression
      buf[offset++] = (Serialization.JSON << 4) | Compression.None;
      // Byte 3: Reserved (header padding)
      buf[offset++] = 0;

      // Event (4字节大端)
      if (hasEvent) {
        buf.writeInt32BE(eventType, offset);
        offset += 4;
      }

      // SessionID (长度前缀 + UTF-8) — 仅当需要时
      if (needsSid && sidBuf) {
        buf.writeUInt32BE(sidBuf.length, offset);
        offset += 4;
        sidBuf.copy(buf, offset);
        offset += sidBuf.length;
      }

      // Payload (长度前缀 + 数据)
      buf.writeUInt32BE(payloadBuf.length, offset);
      offset += 4;
      payloadBuf.copy(buf, offset);

      return buf;
    }

    /**
     * 解析火山引擎返回的自定义二进制帧 (unmarshal)
     * 返回 { eventType, sessionId, connectId, payload }
     */
    function unmarshal(data) {
      if (data.length < 4) return null;
      let offset = 0;

      const versionHeaderSize = data[offset++];
      // const version = (versionHeaderSize >> 4) & 0x0f;
      const headerSize = versionHeaderSize & 0x0f;
      const msgTypeFlag = data[offset++];
      const msgType = (msgTypeFlag >> 4) & 0x0f;
      const msgFlag = msgTypeFlag & 0x0f;
      const serialCompress = data[offset++];
      // const serial = (serialCompress >> 4) & 0x0f;
      // const compress = serialCompress & 0x0f;

      // 跳过头部填充
      const headerBytes = 4 * headerSize;
      if (data.length < headerBytes) return null;
      offset = headerBytes; // 直接跳到header之后

      let eventType = null, sessionId = null, connectId = null;

      // 如果是音频帧，直接返回payload
      if (msgType === MsgType.AudioOnlyServer) {
        if (data.length < offset + 4) return null;
        const payloadLen = data.readUInt32BE(offset);
        offset += 4;
        if (data.length < offset + payloadLen) return null;
        return { payload: data.slice(offset, offset + payloadLen) };
      }

      // 文本帧解析Event
      if (msgFlag & MsgFlag.WithEvent) {
        if (data.length < offset + 4) return null;
        eventType = data.readInt32BE(offset);
        offset += 4;

        // 跳过SessionID（如果存在）
        const needsSid = eventType !== undefined &&
          eventType !== EventType.StartConnection &&
          eventType !== EventType.FinishConnection &&
          eventType !== EventType.ConnectionStarted &&
          eventType !== EventType.ConnectionFailed &&
          eventType !== EventType.ConnectionFinished;

        if (needsSid) {
          if (data.length < offset + 4) return null;
          const sidLen = data.readUInt32BE(offset);
          offset += 4;
          if (sidLen > 0 && data.length >= offset + sidLen) {
            sessionId = data.slice(offset, offset + sidLen).toString('utf8');
            offset += sidLen;
          }
        }
      }

      // Payload
      if (data.length < offset + 4) return null;
      const payloadLen = data.readUInt32BE(offset);
      offset += 4;
      if (data.length < offset + payloadLen) return null;
      const payload = data.slice(offset, offset + payloadLen);

      return { eventType, sessionId, connectId, payload };
    }

    /**
     * 构建标准WebSocket帧并发送
     */
    function sendBinaryFrame(payload) {
      const data = payload; // 直接使用Buffer，不再转UTF-8
      const length = data.length;
      const mask = crypto.randomBytes(4);

      // 使用二进制帧 (opcode 0x02)，因为火山引擎使用自定义二进制协议
      let header;
      if (length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x82; // FIN + binary opcode
        header[1] = 0x80 | length;
      } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }

      const maskedData = Buffer.alloc(length);
      for (let i = 0; i < length; i++) {
        maskedData[i] = data[i] ^ mask[i % 4];
      }

      socket.write(Buffer.concat([header, mask, maskedData]));
    }

    // ========== 发起WebSocket连接 ==========
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

      // ① 建立连接 (StartConnection)
      sendBinaryFrame(marshal(EventType.StartConnection, null, '{}'));

      let buffer = Buffer.alloc(0);

      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);

        // 解析标准WebSocket帧
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          const masked = (buffer[1] & 0x80) !== 0;
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

          // 跳过掩码（服务器→客户端帧不需要掩码，但以防万一）
          if (masked) {
            if (buffer.length < offset + 4 + payloadLength) break;
            offset += 4; // 跳过4字节掩码
          }

          if (buffer.length < offset + payloadLength) break;

          let payload = buffer.slice(offset, offset + payloadLength);
          buffer = buffer.slice(offset + payloadLength);

          // 如果服务器帧有掩码，需要解码
          if (masked) {
            const maskBytes = buffer.slice(offset - 4, offset);
            const decoded = Buffer.alloc(payloadLength);
            for (let i = 0; i < payloadLength; i++) {
              decoded[i] = payload[i] ^ maskBytes[i % 4];
            }
            payload = decoded;
          }

          if (opcode === 0x02) {
            // 二进制帧 — 解析火山引擎自定义协议
            const msg = unmarshal(payload);
            if (msg && msg.payload) {
              // 是包含 payload 的消息
              if (msg.eventType !== undefined && msg.eventType !== null) {
                // 有事件的消息（控制帧）
                const responseText = msg.payload.toString('utf8');
                let responseJson;
                try {
                  responseJson = JSON.parse(responseText);
                } catch (e) {
                  responseJson = {};
                }

                                if (msg.eventType === EventType.ConnectionStarted) {
                  // ② 创建会话
                  const sessionPayload = JSON.stringify({
                    event: EventType.StartSession,
                    req_params: {
                      speaker: voiceId,
                      audio_params: { format: 'mp3', sample_rate: 24000 }
                    }
                  });
                  sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
                  sendBinaryFrame(marshal(EventType.StartSession, sessionId, sessionPayload));
                } else if (msg.eventType === EventType.SessionStarted) {
                  // ③ 发送文本
                  const taskPayload = JSON.stringify({
                    event: EventType.TaskRequest,
                    req_params: { text: text }
                  });
                  sendBinaryFrame(marshal(EventType.TaskRequest, sessionId, taskPayload));
                } else if (msg.eventType === EventType.TTSSentenceEnd) {
                  // ④ 文本合成完毕，结束会话
                  sendBinaryFrame(marshal(EventType.FinishSession, sessionId, '{}'));
                } else if (msg.eventType === EventType.SessionFinished) {
                  // ⑤ 结束连接
                  sendBinaryFrame(marshal(EventType.FinishConnection, null, '{}'));
                } else if (msg.eventType === EventType.ConnectionFinished) {
                  socket.end();
                } else if (msg.eventType === EventType.ConnectionFailed) {
                  errorMessage = responseJson.error || responseJson.message || '连接失败';
                  socket.end();
                } else if (msg.eventType === EventType.SessionFailed) {
                  errorMessage = responseJson.error || responseJson.message || 'TTS 合成失败';
                  socket.end();
                }
              } else {
                // 没有事件的消息 — 这是音频数据
                audioChunks.push(msg.payload);
              }
            }
          } else if (opcode === 0x08) {
            // 关闭帧
            socket.end();
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