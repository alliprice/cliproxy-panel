import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import { parseRoutingStrategy, useVisualConfig } from '../src/hooks/useVisualConfig';

describe('visual config weighted routing strategy', () => {
  test('recognizes the weighted-round-robin backend value', () => {
    expect(parseRoutingStrategy('weighted-round-robin')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('weightedroundrobin')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('wrr')).toBe('weighted-round-robin');
    expect(parseRoutingStrategy('fill-first')).toBe('fill-first');
    expect(parseRoutingStrategy('fillfirst')).toBe('fill-first');
    expect(parseRoutingStrategy('ff')).toBe('fill-first');
    expect(parseRoutingStrategy('expiring-first')).toBe('expiring-first');
    expect(parseRoutingStrategy('expiringfirst')).toBe('expiring-first');
    expect(parseRoutingStrategy(' Expiring-First ')).toBe('expiring-first');
    expect(parseRoutingStrategy(undefined)).toBe('round-robin');
  });

  test('writes weighted-round-robin without coercing it to round-robin', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.setVisualValues({ routingStrategy: 'weighted-round-robin' });
        setPhase(1);
      } else {
        return createElement(
          'pre',
          null,
          visualConfig.applyVisualChangesToYaml('routing:\n  strategy: round-robin\n')
        );
      }

      return null;
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const result = markup.slice('<pre>'.length, -'</pre>'.length);

    expect(parseYaml(result)).toEqual({ routing: { strategy: 'weighted-round-robin' } });
  });

  test('keeps expiring-first in the YAML when the strategy field is unchanged', () => {
    const source = 'routing:\n  strategy: expiring-first\n';

    function Harness({ touchOtherField }: { touchOtherField: boolean }) {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.loadVisualValuesFromYaml(source);
        setPhase(1);
      } else if (phase === 1) {
        if (touchOtherField) {
          visualConfig.setVisualValues({ routingSessionAffinity: true });
        }
        setPhase(2);
      } else {
        return createElement(
          'pre',
          null,
          `${visualConfig.visualValues.routingStrategy}\n---\n${visualConfig.applyVisualChangesToYaml(source)}`
        );
      }

      return null;
    }

    for (const touchOtherField of [false, true]) {
      const markup = renderToStaticMarkup(createElement(Harness, { touchOtherField }));
      const [loadedStrategy, result] = markup
        .slice('<pre>'.length, -'</pre>'.length)
        .split('\n---\n');

      expect(loadedStrategy).toBe('expiring-first');
      const parsed = parseYaml(result) as { routing: Record<string, unknown> };
      expect(parsed.routing.strategy).toBe('expiring-first');
    }
  });

  test('writes expiring-first when the strategy field is changed to it', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.setVisualValues({ routingStrategy: 'expiring-first' });
        setPhase(1);
      } else {
        return createElement(
          'pre',
          null,
          visualConfig.applyVisualChangesToYaml('routing:\n  strategy: round-robin\n')
        );
      }

      return null;
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const result = markup.slice('<pre>'.length, -'</pre>'.length);

    expect(parseYaml(result)).toEqual({ routing: { strategy: 'expiring-first' } });
  });
});
