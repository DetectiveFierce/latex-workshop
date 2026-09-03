import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ALargeSmall, Minus, Plus, RotateCcw } from 'lucide-react';
import { IconButton } from './Button';
import { useAppearance } from '../lib/appearance';

export function AppearanceMenu() {
  const { preferences, update } = useAppearance();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label="Text size">
          <ALargeSmall size={18} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown appearance-menu" align="end" sideOffset={6}>
          <div className="appearance-heading">
            <span>Text size</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Reset text sizes"
              title="Reset text sizes"
              onClick={() => update({ editorFontSize: 13, uiScale: 1 })}
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <SizeControl
            label="Editor"
            value={`${preferences.editorFontSize}px`}
            decrease={() => update({ editorFontSize: preferences.editorFontSize - 1 })}
            increase={() => update({ editorFontSize: preferences.editorFontSize + 1 })}
          />
          <SizeControl
            label="Interface"
            value={`${Math.round(preferences.uiScale * 100)}%`}
            decrease={() => update({ uiScale: preferences.uiScale - 0.05 })}
            increase={() => update({ uiScale: preferences.uiScale + 0.05 })}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SizeControl({
  label,
  value,
  decrease,
  increase,
}: {
  label: string;
  value: string;
  decrease: () => void;
  increase: () => void;
}) {
  return (
    <div className="appearance-control">
      <span>{label}</span>
      <div>
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()} text`}
          onClick={decrease}
        >
          <Minus size={14} />
        </button>
        <output>{value}</output>
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()} text`}
          onClick={increase}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
