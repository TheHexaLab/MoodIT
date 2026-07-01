import React from 'react';
import { ChoiceQuestion } from './ChoiceQuestion';
import { OrderingQuestion } from './OrderingQuestion';
import { MatchingQuestion } from './MatchingQuestion';
import { CodingQuestion } from './CodingQuestion';
import { type QuestionViewProps } from './types';

/** Aiguille vers le rendu correspondant au type de question (saisie ou révision). */
export function QuestionRenderer(props: QuestionViewProps): React.ReactElement {
  switch (props.question.qType) {
    case 'true_false':
    case 'single_choice':
    case 'multiple_choice':
      return <ChoiceQuestion {...props} />;
    case 'ordering':
      return <OrderingQuestion {...props} />;
    case 'matching':
      return <MatchingQuestion {...props} />;
    case 'coding':
      return <CodingQuestion {...props} />;
  }
}
