import React from 'react';

function TestComponent() {
  const handleClick = () => console.log('clicked');
  const show = () => console.log('show');
  const hide = () => console.log('hide');

  return (
    <div>
      {/* jsx-img-alt-missing: no alt prop */}
      <img src="photo.jpg" />

      {/* jsx-onclick-no-keyboard: onClick but no keyboard handler */}
      <div onClick={handleClick}>Click me</div>

      {/* jsx-interactive-no-role: onClick on span with no role */}
      <span onClick={handleClick}>Interactive span</span>

      {/* jsx-anchor-no-content: empty anchor */}
      <a href="/about"></a>

      {/* jsx-label-missing: input with no label */}
      <input type="text" />

      {/* jsx-aria-invalid-role: typo in role value */}
      <div role="buton">Not a button</div>

      {/* jsx-mouse-events-no-focus: onMouseOver with no onFocus */}
      <div onMouseOver={show} onMouseOut={hide}>Hover me</div>

      {/* jsx-heading-empty: empty heading */}
      <h2></h2>
    </div>
  );
}

export default TestComponent;
