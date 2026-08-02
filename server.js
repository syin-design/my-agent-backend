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
app.options('*', cors());
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
        res.setHeader('Access-Control-Allow-Origin', '*');
        
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

    // ----- 2. 存入用户消息（如果是重新生成，跳过，因为用户消息已经存在）-----
if (!req.body.regenerate) {
  await supabase.from('messages').insert({
    sessionid: currentSessionId,
    role: 'user',
    content: message
  });
}

        // ----- 3. 加载历史消息（加载全部可见消息，后续动态裁剪）-----
    const { data: allHistory } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('sessionid', currentSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(200); // 最多取200条，防止查询过重

    // ----- 4. 获取系统设置（含压缩参数）-----
    const settings = await getSettings();
    // 从 settings 表中读取压缩相关参数（若不存在则使用默认值）
    const maxContextTokens = settings.max_context_tokens || 4000;
    const compressThreshold = settings.compress_threshold_tokens || 3000;
    const compressKeepRounds = settings.compress_keep_rounds || 5;

    // ----- 4.5 记忆压缩 -----
    let historyMessages = allHistory || [];

        // 处理重新生成 / 编辑重发
    if (req.body.regenerate && historyMessages.length > 0) {
      // 移除最后一条 AI 回复，并在数据库中标记为不可见
      let regeneratedMessageId = null;
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        if (historyMessages[i].role === 'assistant') {
          regeneratedMessageId = historyMessages[i].id;
          historyMessages.splice(i, 1);
          break;
        }
      }
      if (regeneratedMessageId) {
        await supabase.from('messages')
          .update({ visible: false })
          .eq('id', regeneratedMessageId);
      }
    }
    if (req.body.truncateAfterId) {
      // 只保留指定 ID 之前的消息（编辑消息位置之前）
      const cutoffId = req.body.truncateAfterId;
      historyMessages = historyMessages.filter(m => m.id < cutoffId);
      // 把该 ID 及之后所有旧消息标记为不可见
      await supabase.from('messages')
        .update({ visible: false })
        .eq('sessionid', currentSessionId)
        .gte('id', cutoffId);
    }

    // 粗略估算 token 数（中文约 1 token/字，英文约 1.3 token/字，这里用字符数*0.5）
    const estimatedTokens = JSON.stringify(historyMessages.map(m => m.content)).length * 0.5;

    if (estimatedTokens > compressThreshold && historyMessages.length > compressKeepRounds * 2) {
      // 分离旧消息和近期消息
      const keepCount = compressKeepRounds * 2; // 保留最近 N 轮（用户+AI 各一条）
      const oldMessages = historyMessages.slice(0, -keepCount);
      const recentMessages = historyMessages.slice(-keepCount);

      if (oldMessages.length > 0) {
        try {
          const deepseekKey = process.env.DEEPSEEK_API_KEY;
          if (deepseekKey) {
            // 构建压缩提示
            const conversationText = oldMessages
              .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
              .join('\n');
            const summaryPrompt = `请将以下对话历史压缩成一段简短的摘要，保留关键信息和上下文：\n${conversationText}`;

            // 调用 DeepSeek API（OpenAI 兼容接口）
            const summaryRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${deepseekKey}`
              },
              body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: summaryPrompt }],
                max_tokens: 200,
                temperature: 0.3,
              })
            });

            if (summaryRes.ok) {
              const summaryData = await summaryRes.json();
              const summary = summaryData.choices?.[0]?.message?.content || '';

              if (summary) {
                // 将摘要存入 memories 表
                await supabase.from('memories').insert({
                  summary: summary,
                  conversation_id: currentSessionId,
                  timestamp: new Date()
                });

                // 标记旧消息为不可见（通过 id 精确更新）
                const oldIds = oldMessages.map(m => m.id);
                if (oldIds.length > 0) {
                  await supabase.from('messages')
                    .update({ visible: false })
                    .in('id', oldIds);
                }

                // 替换历史消息为近期消息
                historyMessages = recentMessages;
              }
            }
          }
        } catch (compressError) {
          console.error('记忆压缩失败，将使用原始历史:', compressError);
          // 压缩失败不影响主流程，继续使用原始历史
        }
      }
    }

    // ----- 5. 组装上下文（三层：系统提示词 + 记忆摘要 + 近期消息）-----
    // 加载最新的记忆摘要（从 memories 表取最近3条）
    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(3);

    const memorySummaries = memories?.map(m => m.summary) || [];

        // 加载最新的优秀示例（最近5条）
    const { data: examples } = await supabase
      .from('good_examples')
      .select('user_content, ai_content')
      .order('created_at', { ascending: false })
      .limit(5);

    let exampleText = '';
    if (examples && examples.length > 0) {
      exampleText = '\n\n以下是你之前被评价为优秀的回复示例，请严格参考这种风格回答：\n';
      examples.reverse().forEach(ex => {
        exampleText += `用户: ${ex.user_content}\nAI: ${ex.ai_content}\n`;
      });
    }
    
    // 构建消息数组
    const messagesForAI = [
      { role: 'system', content: settings.system_prompt + exampleText },
      // 中间层：记忆摘要（如果有）
      ...(memorySummaries.length > 0
        ? [{ role: 'system', content: '【之前的对话摘要】\n' + memorySummaries.join('\n') }]
        : []),
      // 底层：近期历史消息
      ...historyMessages.map(m => ({ role: m.role, content: m.content }))
    ];

    // 控制上下文总 token 量（简单裁剪，保证不超过最大限制）
    while (
      JSON.stringify(messagesForAI.map(m => m.content)).length > maxContextTokens * 2 &&
      messagesForAI.length > 3 // 保留系统提示词和至少一轮对话
    ) {
      // 移除最旧的一条聊天消息（不删系统提示词和摘要）
      let removed = false;
      for (let i = 0; i < messagesForAI.length; i++) {
        if (messagesForAI[i].role !== 'system') {
          messagesForAI.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) break; // 防止死循环
    }
        // ----- 6. 调用模型 API（流式，支持多模型切换）-----
    const requestedModel = req.body.model || 'doubao';  // 默认豆包

    let apiUrl, apiHeaders, apiBody;

    if (requestedModel === 'deepseek') {
      // DeepSeek API
      const deepseekKey = process.env.DEEPSEEK_API_KEY;
      if (!deepseekKey) {
        return res.status(500).json({ error: 'DeepSeek API Key 未配置' });
      }
      apiUrl = 'https://api.deepseek.com/v1/chat/completions';
      apiHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      };
      apiBody = {
        model: 'deepseek-chat',
        messages: messagesForAI,
        stream: true,
        max_tokens: settings.max_reply_tokens || 1024,
        temperature: settings.temperature || 0.7
      };
    } else {
      // 默认豆包
      const doubaoKey = process.env.DOUBAO_API_KEY;
      const doubaoModelId = process.env.DOUBAO_MODEL_ID;
      if (!doubaoKey || !doubaoModelId) {
        return res.status(500).json({ error: '豆包 API Key 或模型 ID 未配置' });
      }
      apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
      apiHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${doubaoKey}`
      };
      apiBody = {
        model: doubaoModelId,
        messages: messagesForAI,
        stream: true,
        max_tokens: settings.max_reply_tokens || 1024,
        temperature: settings.temperature || 0.7
      };
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(apiBody)
    });

        if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API 请求失败 (${response.status})`);
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullReply = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data:'));
        for (const line of lines) {
          const json = line.slice(5).trim();
          if (json === '[DONE]') continue;
          try {
            const parsed = JSON.parse(json);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullReply += delta;
              res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch (e) { /* 忽略解析错误 */ }
        }
      }
    } catch (streamError) {
      console.error('流式读取错误:', streamError);
      res.write(`data: ${JSON.stringify({ error: '流式传输中断' })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();

        // ----- 7. 存入 AI 回复（完整文本）-----
    if (fullReply) {
      await supabase.from('messages').insert({
        sessionid: currentSessionId,
        role: 'assistant',
        content: fullReply
      });
      await supabase.from('sessions').update({ updated_at: new Date() }).eq('id', currentSessionId);
    }
  } catch (error) {
    console.error('聊天接口出错:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'AI 服务暂时不可用' });
    }
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
  await supabase.from('messages').delete().eq('sessionid', id);
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ========== 保存优秀示例 ==========
app.post('/api/good-examples', async (req, res) => {
  try {
    const { sessionId, aiContent } = req.body;
    if (!sessionId || !aiContent) {
      return res.status(400).json({ error: '缺少 sessionId 或 aiContent' });
    }

    // 找到该 AI 回复之前的最近一条用户消息
    const { data: userMsg } = await supabase
      .from('messages')
      .select('content')
      .eq('sessionid', sessionId)
      .eq('role', 'user')
      .lt('created_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!userMsg) {
      return res.status(404).json({ error: '未找到对应的用户消息' });
    }

    const { error } = await supabase.from('good_examples').insert({
      sessionid: sessionId,
      user_content: userMsg.content,
      ai_content: aiContent,
    });

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('保存示例失败:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`后端服务运行在端口 ${PORT}`);
});