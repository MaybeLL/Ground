import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Client } from './client.js';
import { BrandIdentity } from './home.js';
import { ReviewApp } from './review-app.js';
import { EvalApp } from './eval-app.js';

export function EntryHome({ width, height, onOpen, onExit }: { width: number; height: number; onOpen: (mode: 'development' | 'evaluation') => void; onExit: () => void }) {
  const [selected, select] = useState(0);
  const small = width < 40 || height < 10;
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onExit(); return; }
    if (small) return;
    if (key.leftArrow) select(0);
    else if (key.rightArrow) select(1);
    else if (key.tab) select(n => 1 - n);
    else if (key.return) onOpen(selected === 0 ? 'development' : 'evaluation');
  });
  if (small) return <Text>请放大至 40×10 · Ctrl+C 退出</Text>;
  const compact = width < 76 || height < 18;
  const cardWidth = Math.floor((Math.min(width - 2, 94) - 2) / 2);
  const colored = process.env.NO_COLOR === undefined;
  return <Box width={width} height={height - 1} flexDirection="column" justifyContent="center" alignItems="center">
    <BrandIdentity tier={width >= 94 && height >= 28 ? 'full' : 'compact'} />
    <Box gap={2} flexShrink={0}>
      {['需求开发', '评测'].map((title, index) => <Box key={title} width={cardWidth} flexShrink={0} borderStyle="round" borderColor={colored ? selected === index ? 'cyan' : 'gray' : undefined} flexDirection="column" paddingX={compact ? 0 : 1}>
        <Text bold color={colored ? selected === index ? 'cyan' : 'gray' : undefined}>{selected === index ? '▸ ' : '  '}{title}</Text>
        {!compact && <Text> </Text>}
        <Text>{compact ? index === 0 ? '需求 · 候选交付' : '资产 · 实验对照' : index === 0 ? '查找需求 · 查看开发进度' : '题集 · 题目 · 评分规则'}</Text>
        {!compact && <Text>{index === 0 ? '审阅候选 · 对照与交付' : '运行状态 · 结果与对照'}</Text>}
      </Box>)}
    </Box>
    <Box flexShrink={0} flexDirection="column" alignItems="center" marginTop={height < 14 ? 0 : 1}><Text>← → / Tab 选择 · Enter 进入</Text><Text dimColor>Ctrl+C 退出</Text></Box>
  </Box>;
}

export function Workbench({ client, startEval = false, onExit, width: fixedWidth, height: fixedHeight }: { client: Client; startEval?: boolean; onExit: () => void; width?: number; height?: number }) {
  const [mode, setMode] = useState<'home' | 'development' | 'evaluation'>(startEval ? 'evaluation' : 'home');
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 30 });
  useEffect(() => { const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 30 }); stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  const width = fixedWidth ?? size.width, height = fixedHeight ?? size.height;
  if (mode === 'home') return <EntryHome width={width} height={height} onOpen={setMode} onExit={onExit} />;
  if (mode === 'evaluation') return <EvalApp access={client} reader={client} writer={client} context={client.context} onExit={onExit} onBack={() => setMode('home')} backLabel="返回首页" width={width} height={height} />;
  return <ReviewApp reader={client} writer={client} context={client.context} onExit={onExit} onEval={() => setMode('evaluation')} onHome={() => setMode('home')} width={width} height={height} />;
}
