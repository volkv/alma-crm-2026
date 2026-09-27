/** Обучение в карточке: слушатели, потоки в системе обучения и документ об обучении. */
import { defineCardUi } from '$lib/platform/card-ui';
import manifest from './index';
import LearnersPanel from './ui/learners-panel.svelte';
import LearningPanel from './ui/learning-panel.svelte';
import TrainingDocumentPanel from './ui/training-document-panel.svelte';

export default defineCardUi(manifest, {
	panels: {
		learners: LearnersPanel,
		learning: LearningPanel,
		training_document: TrainingDocumentPanel
	},
	headerFacts: {},
	dialogs: null
});
