/* shadcn/ui-derived */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { cn } from '../../lib/utils';
import { usePortalScopeProps } from '../../lib/portal-scope';
import { useBrowserDimmingModal } from '../../hooks/useBrowserDimmingModal';
import {
  DrawerDescription as DrawerDescriptionPrimitive,
  DrawerTitle as DrawerTitlePrimitive
} from './drawer.js';
import {
  type ResponsiveOverlayContextValue,
  ResponsiveDrawerShell,
  stripRadixContentProps,
  useResponsiveRoot
} from './responsive-overlay.js';
import { Icon } from './icon.js';

const ResponsiveDialogContext =
  React.createContext<ResponsiveOverlayContextValue>({
    isCompactViewport: false,
    open: false,
    onOpenChange: () => undefined
  });

function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext);
}

function Dialog({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const context = useResponsiveRoot(controlledOpen, controlledOnChange);
  const body = context.isCompactViewport ? (
    children
  ) : (
    <DialogPrimitive.Root
      open={context.open}
      onOpenChange={context.onOpenChange}
      {...props}
    >
      {children}
    </DialogPrimitive.Root>
  );
  return (
    <ResponsiveDialogContext.Provider value={context}>
      {body}
    </ResponsiveDialogContext.Provider>
  );
}

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    {...usePortalScopeProps()}
    className={cn(
      'fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
>;

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, children, ...props }, ref) => {
    const { isCompactViewport, open, onOpenChange } = useResponsiveDialog();
    useBrowserDimmingModal(open);
    const scopeProps = usePortalScopeProps();

    if (isCompactViewport) {
      return (
        <ResponsiveDrawerShell open={open} onOpenChange={onOpenChange}>
          <div
            ref={ref}
            className={cn(
              'grid max-h-[85dvh] gap-4 overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]',
              className,
              'max-w-none'
            )}
            {...stripRadixContentProps(props)}
          >
            {children}
          </div>
        </ResponsiveDrawerShell>
      );
    }

    return (
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          {...scopeProps}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            className
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close className="absolute top-4 right-4 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none">
            <Icon name="X" className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }
);
DialogContent.displayName = 'DialogContent';

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-left', className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  const { isCompactViewport } = useResponsiveDialog();
  const Component = isCompactViewport
    ? DrawerTitlePrimitive
    : DialogPrimitive.Title;
  return (
    <Component
      ref={ref}
      className={cn('text-base leading-none font-semibold', className)}
      {...props}
    />
  );
});
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => {
  const { isCompactViewport } = useResponsiveDialog();
  const Component = isCompactViewport
    ? DrawerDescriptionPrimitive
    : DialogPrimitive.Description;
  return (
    <Component
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
};
