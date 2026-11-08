'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { name: string; done?: boolean }[];
}

interface SiteConfig {
  name: string;
  welcome: string;
  suggestedQuestions: string[];
}

function MarkdownBlock({ content }: { content: string }) {
  const html = marked.parse(content) as string;
  return <div className="prose-chat" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AssistantLogo({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8c-5.2 0-9.4 3.6-9.4 8 0 2.4 1.2 4.6 3.2 6.1-.2 1.2-.7 2.3-1.4 3.3 2-.3 3.8-1 5.3-2 .7.1 1.5.2 2.3.2 5.2 0 9.4-3.6 9.4-7.6 0-4.4-4.2-8-9.4-8Zm-3.6 8.2a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Zm3.6 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Zm3.6 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6Z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m12 2 2.1 6.3L20.5 9l-5.1 3.9 1.7 6.3L12 15.6l-5.1 3.6 1.7-6.3L3.5 9l6.4-.7L12 2Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="aa-suggest-arrow" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.53 12 8.32 6.23l1.36-1.47 7 6.5.79.74-.79.73-7 6.5-1.36-1.47L14.53 12z" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

function ToolBadge({ name, done, isZh }: { name: string; done: boolean; isZh: boolean }) {
  return (
    <span className={`aa-tool ${done ? 'aa-tool-done' : ''}`}>
      {done ? (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor" />
        </svg>
      ) : (
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2a10 10 0 0 1 10 10h-2a8 8 0 0 0-8-8V2z" fill="currentColor" />
        </svg>
      )}
      {done
        ? (isZh ? `已查询 ${name}` : `Queried ${name}`)
        : (isZh ? `正在查询 ${name}` : `Querying ${name}`)}
    </span>
  );
}

export default function ChatPanel({ mode = 'full' }: { mode?: 'full' | 'widget' }) {
  const [config, setConfig] = useState<SiteConfig>({ name: '站内问答', welcome: '', suggestedQuestions: [] });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isZh, setIsZh] = useState(true);

  useEffect(() => {
    setIsZh(navigator.language?.startsWith('zh') ?? false);
  }, []);

  const [conversationId] = useState(() => {
    if (typeof window === 'undefined') return '';
    const key = 'ai-chat-assistant-cid';
    const TTL = 24 * 60 * 60 * 1000; // 24 小时后换一个会话标识，避免长期关联
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const [cid, ts] = raw.split('|');
        if (cid && Number.isFinite(Number(ts)) && Date.now() - Number(ts) < TTL) return cid;
      }
      const cid = crypto.randomUUID();
      localStorage.setItem(key, `${cid}|${Date.now()}`);
      return cid;
    } catch {
      return crypto.randomUUID();
    }
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);
  const pageContextRef = useRef<{ title?: string; url?: string; content?: string } | null>(null);

  // Load config
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => {
        setConfig({
          name: c.name || '站内问答',
          welcome: c.welcome || '',
          suggestedQuestions: c.suggestedQuestions || [],
        });
      })
      .catch(() => {});
  }, []);

  // 父页面消息：正文上下文 / 关闭时收起键盘 / 主题明暗同步。
  // 全部是浏览器本地 postMessage，不产生任何网络请求。
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== 'object') return;

      if (d.type === '__aa_page_context' && d.payload) {
        pageContextRef.current = d.payload;
        return;
      }

      // 关闭面板时输入框失焦，收起 iOS 虚拟键盘，否则父页滚动会被锁住。
      if (d.type === '__aa_blur') {
        const el = document.activeElement as HTMLElement | null;
        if (el && typeof el.blur === 'function') el.blur();
        return;
      }

      if (d.type === '__aa_theme' && d.payload) {
        const p = d.payload as Record<string, string>;
        const root = document.documentElement;
        root.dataset.aaTheme = p.mode === 'dark' ? 'dark' : 'light';
        const vars: [string, string | undefined][] = [
          ['--aa-primary', p.primary],
          ['--aa-bg', p.bg],
          ['--aa-surface', p.surface],
          ['--aa-text', p.text],
        ];
        vars.forEach(([k, v]) => { if (v) root.style.setProperty(k, v); });
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 把对话阶段告诉父页面的悬浮角色，让它切换表情。
  // widget 直接打开时 parent === self，消息会被自己忽略，无副作用。
  const emitEmotion = useCallback((state: string) => {
    if (typeof window === 'undefined' || window.parent === window) return;
    try {
      window.parent.postMessage({ type: '__aa_emotion', state }, '*');
    } catch {}
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const sendMessage = useCallback(async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || isStreaming) return;
    setInput('');
    setIsStreaming(true);

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: msg };
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', content: '' }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let replied = false;
    let failed = false;
    emitEmotion('thinking');

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'makers-conversation-id': conversationId,
        },
        body: JSON.stringify({
          message: msg,
          ...(pageContextRef.current ? { pageContext: pageContextRef.current } : {}),
        }),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;
          try {
            const event = JSON.parse(payload);
            if (event.type === 'text_delta' && event.delta) {
              if (!replied) { replied = true; emitEmotion('replying'); }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + event.delta } : m,
                ),
              );
            } else if (event.type === 'tool_call' && event.tool) {
              emitEmotion('searching');
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, toolCalls: [...(m.toolCalls || []), { name: event.tool }] }
                    : m,
                ),
              );
            } else if (event.type === 'tool_result' && event.tool) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId || !m.toolCalls) return m;
                  const updated = m.toolCalls.map((tc) =>
                    tc.name === event.tool && !tc.done ? { ...tc, done: true } : tc,
                  );
                  return { ...m, toolCalls: updated };
                }),
              );
            } else if (event.type === 'error_message') {
              failed = true;
              const text = String(event.content || '');
              const limited = /限额|限流|频繁|稍后|控制|重试|过多|上限/.test(text);
              emitEmotion(limited ? 'refused' : 'error');
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content || `⚠️ ${event.content}` }
                    : m,
                ),
              );
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        failed = true;
        emitEmotion('error');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || '⚠️ 连接失败，请稍后再试。' }
              : m,
          ),
        );
      }
    } finally {
      if (!failed) emitEmotion('done');
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, conversationId, emitEmotion]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    emitEmotion('idle');
    fetch('/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId }),
    }).catch(() => {});
  }, [conversationId, emitEmotion]);

  const clearChat = useCallback(() => {
    setMessages([]);
    emitEmotion('idle');
    if (typeof window !== 'undefined') {
      localStorage.removeItem('ai-chat-assistant-cid');
    }
  }, [emitEmotion]);

  const isWidget = mode === 'widget';

  return (
    <div className={`aa-root flex flex-col ${isWidget ? 'h-full' : 'h-screen'}`}>
      {/* Header */}
      <div className="aa-header">
        <div className="aa-brand">
          <AssistantLogo className="aa-logo" />
          <span className="aa-title">{config.name}</span>
        </div>
        <div className="aa-header-actions">
          {!isWidget && (
            <>
              <a
                href="https://github.com/TencentEdgeOne/AI-Chat-Assistant"
                target="_blank"
                rel="noopener noreferrer"
                className="aa-icon-btn"
                title="GitHub"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              </a>
              <a
                href="https://edgeone.ai/makers/new?template=ai-chat-assistant&from=within&fromAgent=1&agentLang=typescript"
                target="_blank"
                rel="noopener noreferrer"
                className="aa-icon-btn"
                title="Deploy"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.5 1.5v5h5v3h-5v5h-3v-5h-5v-3h5v-5h3z" fill="currentColor"/></svg>
              </a>
              <button onClick={() => setIsZh(z => !z)} className="aa-icon-btn" title="Switch language">
                {isZh ? 'EN' : '中'}
              </button>
            </>
          )}
          {messages.length > 0 && (
            <button onClick={clearChat} className="aa-icon-btn" title={isZh ? '清空对话' : 'Clear chat'}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M0.667 13.982H13.334V4.316H9V0.496H5V4.316H0.667V13.982ZM2 12.649V8.982H12V12.649H5V10.316H3.667V12.649H2ZM12 7.649H2V5.649H6.333V1.829H7.667V5.649H12V7.649Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" fillOpacity="0.8"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="aa-messages flex-1 overflow-y-auto">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <AssistantLogo className="aa-welcome-logo" />
            <h3 className="aa-welcome-title" style={{ marginTop: 18 }}>{config.name}</h3>
            <p className="aa-welcome-text">
              {config.welcome || '有什么想问的？'}
            </p>

            {config.suggestedQuestions.length > 0 && (
              <div className="aa-suggest-list">
                {config.suggestedQuestions.map((q, i) => (
                  <button key={i} onClick={() => sendMessage(q)} className="aa-suggest">
                    <span className="aa-suggest-label">{q}</span>
                    <ArrowIcon />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="space-y-4">
          {messages.map((msg) => (
            <div key={msg.id} className={`aa-msg-row ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {msg.role === 'assistant' && (
                <div className="aa-avatar"><StarIcon /></div>
              )}
              <div className={`aa-bubble ${msg.role === 'user' ? 'aa-bubble-user' : 'aa-bubble-ai'}`}>
                {msg.role === 'user' ? (
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                ) : msg.content ? (
                  <div className="relative">
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-2">
                        {msg.toolCalls.map((tc, i) => (
                          <ToolBadge key={i} name={tc.name} done={!!tc.done} isZh={isZh} />
                        ))}
                      </div>
                    )}
                    <MarkdownBlock content={msg.content} />
                    {isStreaming && msg.id === messages[messages.length - 1]?.id && (
                      <span className="aa-cursor" />
                    )}
                  </div>
                ) : (
                  <div className="py-1">
                    {msg.toolCalls && msg.toolCalls.length > 0 ? (
                      <div>
                        {msg.toolCalls.map((tc, i) => (
                          <ToolBadge key={i} name={tc.name} done={!!tc.done} isZh={isZh} />
                        ))}
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <span className="aa-dot animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="aa-dot animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="aa-dot animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="aa-inputbar">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder={isZh ? '有问题？随时问我…' : 'Got questions? Feel free to ask.'}
          rows={1}
          className="aa-input"
          style={{ minHeight: '40px', maxHeight: '120px' }}
        />
        {isStreaming ? (
          <button onClick={stopStream} className="aa-stop" title={isZh ? '停止' : 'Stop'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
          </button>
        ) : (
          <button onClick={() => sendMessage()} disabled={!input.trim()} className="aa-send" title={isZh ? '发送' : 'Send'}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M0.99 7.67c-.48-.16-.49-.42.01-.59L18.71 1.17c.49-.16.77.08.63.57L14.28 19.5c-.14.49-.42.5-.63.04L10.32 12.02l5.57-7.43-7.42 5.57L0.99 7.67z" fill="currentColor"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
