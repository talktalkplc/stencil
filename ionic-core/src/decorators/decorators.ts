import { setAnnotation, getAnnotation } from './annotations';
import { ComponentMeta, ComponentCompiledMeta, InputMeta, OutputMeta } from '../shared/interfaces';


const COMPONENT_KEY = 'Component';
const INPUT_KEY = 'Input';
const OUTPUT_KEY = 'Output';


export function getComponentMeta(cls: any): ComponentCompiledMeta {
  return getAnnotation(cls, COMPONENT_KEY);
}


export function getInputMeta(cls: any, prop: string): InputMeta {
  return getAnnotation(cls, INPUT_KEY);
}


export function getOutputMeta(cls: any, prop: string): OutputMeta {
  return getAnnotation(cls, OUTPUT_KEY);
}


export interface ComponentDecorator {
  (obj: ComponentMeta): any;
}


export const Component: ComponentDecorator = function(metadata: ComponentMeta): (cls: any) => any {
  return function(cls: any) {
    setAnnotation(cls, COMPONENT_KEY, metadata);
    return cls;
  };
};


export interface InputDecorator {
  (obj?: InputMeta): any;
}


export const Input: InputDecorator = function(metadata: InputMeta): (cls: any) => any {
  return function(cls: any) {
    setAnnotation(cls, INPUT_KEY, metadata);
    return cls;
  };
};


export interface OutputDecorator {
  (obj?: OutputMeta): any;
}


export const Output: OutputDecorator = function(metadata: OutputMeta): (cls: any) => any {
  return function(cls: any) {
    setAnnotation(cls, OUTPUT_KEY, metadata);
    return cls;
  };
};