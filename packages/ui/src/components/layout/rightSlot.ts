import { create } from 'zustand';


type RightSlotState = {
  workStatusHost: HTMLElement | null;
  workStatusReserved: boolean;
  workStatusBesidePanel: boolean;
  chatCovered: boolean;
};

export const useRightSlotStore = create<RightSlotState>(() => ({
  workStatusHost: null,
  workStatusReserved: false,
  workStatusBesidePanel: false,
  chatCovered: false,
}));

export const setWorkStatusHost = (node: HTMLElement | null): void => {
  if (useRightSlotStore.getState().workStatusHost !== node) useRightSlotStore.setState({ workStatusHost: node });
};

export const setChatCovered = (covered: boolean): void => {
  if (useRightSlotStore.getState().chatCovered !== covered) useRightSlotStore.setState({ chatCovered: covered });
};

export const setWorkStatusColumn = (reserved: boolean, besidePanel: boolean): void => {
  const state = useRightSlotStore.getState();
  if (state.workStatusReserved !== reserved || state.workStatusBesidePanel !== besidePanel) {
    useRightSlotStore.setState({ workStatusReserved: reserved, workStatusBesidePanel: besidePanel });
  }
};
