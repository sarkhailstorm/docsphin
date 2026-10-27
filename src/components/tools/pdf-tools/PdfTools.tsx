'use client';

import { useState } from 'react';
import {
  Combine,
  FileImage,
  FileSpreadsheet,
  FileType2,
  Hash,
  Images,
  KeyRound,
  LayoutGrid,
  Lock,
  Minimize2,
  Scissors,
  Stamp,
  Table2,
  Text,
} from 'lucide-react';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';
import { CompressPanel } from './CompressPanel';
import { ExcelPanel } from './ExcelPanel';
import { ExcelToPdfPanel } from './ExcelToPdfPanel';
import { ImagesPanel } from './ImagesPanel';
import { MergePanel } from './MergePanel';
import { OrganisePanel } from './OrganisePanel';
import { PageNumbersPanel } from './PageNumbersPanel';
import { PasswordPanel } from './PasswordPanel';
import { PdfToImagesPanel } from './PdfToImagesPanel';
import { ProtectPanel } from './ProtectPanel';
import { SplitPanel } from './SplitPanel';
import { WatermarkPanel } from './WatermarkPanel';
import { WordPanel } from './WordPanel';
import { WordToPdfPanel } from './WordToPdfPanel';

type Mode =
  | 'merge'
  | 'split'
  | 'organise'
  | 'compress'
  | 'protect'
  | 'unlock'
  | 'numbers'
  | 'watermark'
  | 'images'
  | 'from-word'
  | 'from-excel'
  | 'to-images'
  | 'word'
  | 'excel';

const TABS: readonly TabItem<Mode>[] = [
  { id: 'merge', label: 'Merge', icon: <Combine className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'split', label: 'Split', icon: <Scissors className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'organise', label: 'Organise', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'compress', label: 'Compress', icon: <Minimize2 className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'protect', label: 'Protect', icon: <Lock className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'unlock', label: 'Unlock', icon: <KeyRound className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'numbers', label: 'Page numbers', icon: <Hash className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'watermark', label: 'Watermark', icon: <Stamp className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'images', label: 'Images to PDF', icon: <Images className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'from-word', label: 'Word to PDF', icon: <Text className="h-3.5 w-3.5" aria-hidden /> },
  {
    id: 'from-excel',
    label: 'Excel to PDF',
    icon: <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />,
  },
  {
    id: 'to-images',
    label: 'PDF to Images',
    icon: <FileImage className="h-3.5 w-3.5" aria-hidden />,
  },
  { id: 'word', label: 'PDF to Word', icon: <FileType2 className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'excel', label: 'PDF to Excel', icon: <Table2 className="h-3.5 w-3.5" aria-hidden /> },
];

export function PdfTools() {
  const [mode, setMode] = useState<Mode>('merge');

  return (
    <div
      className="flex flex-col gap-5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <Tabs tabs={TABS} active={mode} onChange={setMode} label="PDF tools" />

      <div role="tabpanel" aria-label="Merge" hidden={mode !== 'merge'} className={cn(mode !== 'merge' && 'hidden')}>
        <MergePanel active={mode === 'merge'} />
      </div>
      <div role="tabpanel" aria-label="Split" hidden={mode !== 'split'} className={cn(mode !== 'split' && 'hidden')}>
        <SplitPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Organise"
        hidden={mode !== 'organise'}
        className={cn(mode !== 'organise' && 'hidden')}
      >
        <OrganisePanel active={mode === 'organise'} />
      </div>
      <div
        role="tabpanel"
        aria-label="Compress"
        hidden={mode !== 'compress'}
        className={cn(mode !== 'compress' && 'hidden')}
      >
        <CompressPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Protect"
        hidden={mode !== 'protect'}
        className={cn(mode !== 'protect' && 'hidden')}
      >
        <ProtectPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Unlock"
        hidden={mode !== 'unlock'}
        className={cn(mode !== 'unlock' && 'hidden')}
      >
        <PasswordPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Page numbers"
        hidden={mode !== 'numbers'}
        className={cn(mode !== 'numbers' && 'hidden')}
      >
        <PageNumbersPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Watermark"
        hidden={mode !== 'watermark'}
        className={cn(mode !== 'watermark' && 'hidden')}
      >
        <WatermarkPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Images to PDF"
        hidden={mode !== 'images'}
        className={cn(mode !== 'images' && 'hidden')}
      >
        <ImagesPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Word to PDF"
        hidden={mode !== 'from-word'}
        className={cn(mode !== 'from-word' && 'hidden')}
      >
        <WordToPdfPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="Excel to PDF"
        hidden={mode !== 'from-excel'}
        className={cn(mode !== 'from-excel' && 'hidden')}
      >
        <ExcelToPdfPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="PDF to Images"
        hidden={mode !== 'to-images'}
        className={cn(mode !== 'to-images' && 'hidden')}
      >
        <PdfToImagesPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="PDF to Word"
        hidden={mode !== 'word'}
        className={cn(mode !== 'word' && 'hidden')}
      >
        <WordPanel />
      </div>
      <div
        role="tabpanel"
        aria-label="PDF to Excel"
        hidden={mode !== 'excel'}
        className={cn(mode !== 'excel' && 'hidden')}
      >
        <ExcelPanel />
      </div>
    </div>
  );
}
