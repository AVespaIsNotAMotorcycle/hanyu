import {
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type InputHTMLAttributes,
} from 'react';
import { convertToneNumbers } from '@hanyu/shared';

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> & {
  value: string;
  onChange: (value: string) => void;
};

/**
 * A text field for pinyin answers. Tone numbers turn into tone marks as they
 * are typed (`xue2` → `xué`, `lv4` → `lǜ`); text from a pinyin IME or a paste
 * is accepted as is. Grade the value with `gradePinyin` from @hanyu/shared.
 */
export function PinyinInput({ value, onChange, ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);

  // Put the caret back where it belongs after a conversion shortens the text.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function update(input: HTMLInputElement) {
    if (composing.current) {
      onChange(input.value);
      return;
    }
    const { text, caret } = convertToneNumbers(
      input.value,
      input.selectionStart ?? input.value.length,
    );
    if (text !== input.value) pendingCaret.current = caret;
    onChange(text);
  }

  return (
    <input
      {...props}
      ref={ref}
      type="text"
      lang="zh-Latn-pinyin"
      value={value}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        update(event.currentTarget)
      }
      // An IME is composing: wait until it commits before converting.
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        update(event.currentTarget);
      }}
    />
  );
}
