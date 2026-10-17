import { useEffect, useRef, useState } from 'react';
import HanziWriter from 'hanzi-writer';
import {
  isStrokeOrderMistake,
  QUIZ_OPTIONS,
  type CharacterContent,
  type HandwritingResult,
} from '@hanyu/shared';

const MAX_SIZE = 320;

/**
 * Draw a character from memory with hanzi-writer's quiz: each stroke is
 * checked against Make Me a Hanzi's stroke data, in stroke order. Reports
 * misses (and which were stroke-order mistakes), hints, and giving up.
 */
export function HandwritingQuiz({
  character,
  onDone,
}: {
  character: CharacterContent;
  onDone: (result: HandwritingResult) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const writer = useRef<HanziWriter | null>(null);
  const result = useRef<HandwritingResult>({
    strokes: character.strokes.length,
    misses: 0,
    orderMisses: 0,
    hinted: false,
    revealed: false,
  });
  const nextStroke = useRef(0);
  const [finished, setFinished] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const div = target.current!;
    const size = Math.min(div.parentElement!.clientWidth, MAX_SIZE);
    div.style.width = div.style.height = `${size}px`;
    // Ink follows the page's text color, so it shows in dark mode too.
    const ink = getComputedStyle(div).color;
    const finish = () => {
      setFinished(true);
      onDoneRef.current({ ...result.current });
    };

    const hw = HanziWriter.create(div, character._id, {
      width: size,
      height: size,
      padding: 12,
      showCharacter: false,
      showOutline: false,
      strokeColor: ink,
      drawingColor: ink,
      highlightColor: '#d97706',
      drawingWidth: 8,
      charDataLoader: (_char, onLoad) =>
        onLoad({ strokes: character.strokes, medians: character.medians }),
    });
    writer.current = hw;
    void hw.quiz({
      leniency: 1,
      showHintAfterMisses: QUIZ_OPTIONS.showHintAfterMisses,
      markStrokeCorrectAfterMisses: QUIZ_OPTIONS.markStrokeCorrectAfterMisses,
      onMistake: (stroke) => {
        const r = result.current;
        r.misses++;
        if (
          isStrokeOrderMistake(
            stroke.drawnPath.points,
            character.medians,
            stroke.strokeNum,
          )
        ) {
          r.orderMisses++;
        }
        // hanzi-writer highlights the stroke once this many misses pile up.
        if (stroke.mistakesOnStroke >= QUIZ_OPTIONS.showHintAfterMisses) {
          r.hinted = true;
        }
      },
      onCorrectStroke: (stroke) => {
        nextStroke.current = stroke.strokeNum + 1;
      },
      onComplete: finish,
    });

    return () => {
      hw.cancelQuiz();
      div.replaceChildren();
      writer.current = null;
    };
  }, [character]);

  function hint() {
    result.current.hinted = true;
    void writer.current?.highlightStroke(nextStroke.current);
  }

  function reveal() {
    const hw = writer.current;
    if (!hw) return;
    result.current.revealed = true;
    hw.cancelQuiz();
    setFinished(true);
    void hw.animateCharacter({
      onComplete: () => onDoneRef.current({ ...result.current }),
    });
  }

  return (
    <div className="handwriting">
      <div
        ref={target}
        className="writing-grid"
        role="img"
        aria-label="Drawing area: write the missing character"
      />
      <p className="credit">
        Stroke data:{' '}
        <a href="https://github.com/skishore/makemeahanzi">Make Me a Hanzi</a>,{' '}
        <a href="/licenses/ARPHICPL.txt">Arphic Public License</a>
      </p>
      {!finished && (
        <div className="handwriting-actions">
          <button type="button" className="link" onClick={hint}>
            Hint
          </button>
          <button type="button" className="link" onClick={reveal}>
            Show answer
          </button>
        </div>
      )}
    </div>
  );
}
