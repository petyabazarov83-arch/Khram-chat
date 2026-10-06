document.addEventListener('DOMContentLoaded', () => {
  console.log('Приложение запущено!');

  // Обработка нажатий клавиш (полезно для пульта Android TV и клавиатуры ПК)
  document.addEventListener('keydown', (event) => {
    switch(event.key) {
      case 'ArrowUp':
        // Нажатие вверх
        break;
      case 'ArrowDown':
        // Нажатие вниз
        break;
      case 'ArrowLeft':
        // Нажатие влево
        break;
      case 'ArrowRight':
        // Нажатие вправо
        break;
      case 'Enter':
        // Нажатие OK / Выбор
        break;
      case 'Backspace':
      case 'Escape':
        // Нажатие "Назад"
        break;
    }
  });
});
