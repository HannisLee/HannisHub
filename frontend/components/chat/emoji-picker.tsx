"use client";

import { EmojiPicker } from "frimousse";

/** 本地托管的 emojibase 中文数据，避免依赖外部 CDN */
const EMOJIBASE_URL = "/emojibase";

/** 表情选择面板：基于 frimousse（无样式、虚拟滚动），样式由 globals.css 按 design.md 定义 */
export function ChatEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <EmojiPicker.Root
      className="chat-emoji-picker"
      locale="zh"
      emojibaseUrl={EMOJIBASE_URL}
      columns={8}
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
    >
      <EmojiPicker.Search className="chat-emoji-search" placeholder="搜索表情" autoFocus />
      <EmojiPicker.Viewport className="chat-emoji-viewport">
        <EmojiPicker.Loading className="chat-emoji-state">正在加载表情…</EmojiPicker.Loading>
        <EmojiPicker.Empty className="chat-emoji-state">没有找到表情</EmojiPicker.Empty>
        <EmojiPicker.List
          className="chat-emoji-list"
          components={{
            CategoryHeader: ({ category, ...props }) => <div className="chat-emoji-category" {...props}>{category.label}</div>,
            Row: ({ children, ...props }) => <div className="chat-emoji-row" {...props}>{children}</div>,
            Emoji: ({ emoji, ...props }) => <button className="chat-emoji-button" title={emoji.label} {...props}>{emoji.emoji}</button>,
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
