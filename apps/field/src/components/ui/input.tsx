import { cn } from '@/lib/utils';
import { Keyboard, Platform, TextInput } from 'react-native';

function Input({ className, returnKeyType, onSubmitEditing, ...props }: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) {
  // Single-line inputs get a "Done" return key that dismisses the keyboard on
  // submit (blurOnSubmit already defaults true for single-line). Multiline
  // inputs keep the platform default (return inserts a newline). Number-pad
  // keyboards have no return key, so those inputs rely on the
  // KeyboardDismissible wrapper / ScrollView tap-off handling to dismiss.
  const singleLine = !props.multiline;
  return (
    <TextInput
      returnKeyType={returnKeyType ?? (singleLine ? 'done' : undefined)}
      onSubmitEditing={
        onSubmitEditing ?? (singleLine ? () => Keyboard.dismiss() : undefined)
      }
      className={cn(
        'dark:bg-input/30 border-input bg-background text-foreground flex h-10 w-full min-w-0 flex-row items-center rounded-md border px-3 py-1 text-base leading-5 shadow-sm shadow-black/5 sm:h-9',
        props.editable === false &&
        cn(
          'opacity-50',
          Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
        ),
        Platform.select({
          web: cn(
            'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
          ),
          native: 'placeholder:text-muted-foreground/50',
        }),
        className
      )}
      {...props}
    />
  );
}

export { Input };
